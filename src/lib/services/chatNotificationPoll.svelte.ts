import { browser } from '$app/environment';
import { queryClient } from '$lib/query-client';
import { joinRequestsQueryOptions } from '$lib/queries/chatJoinRequestQueries';
import { welcomeNotificationsQueryOptions } from '$lib/queries/chatWelcomeQueries';
import { manager } from '$lib/services/accountManager.svelte';
import { notifyForJoinRequests, notifyForWelcomes } from '$lib/services/chatAttention.svelte';
import { autoApproveJoinRequests } from '$lib/services/chatAutoApprove.svelte';
import {
	getCoordinatorLabel,
	listKnownCoordinatorKeys
} from '$lib/services/chatCoordinators.svelte';
import { isSignerUnavailableError } from '$lib/services/chatRuntime';
import { isNativePlatform } from '$lib/services/nativeBridge';
import { errorMessage as errorText } from '$lib/utils';

export const NOTIFICATION_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Read by the notifications dialog; the poll owns it so every route sees it. */
export const notificationPollState = $state<{ refreshing: boolean; failures: string[] }>({
	refreshing: false,
	failures: []
});

/**
 * Welcomes ride the stable lane. On Android that is the NIP-55 activity or a
 * relay round-trip, neither of which can start from a backgrounded WebView — so
 * skip them while hidden and let the next foreground poll catch up. Join
 * requests are signer-free and always poll.
 */
function shouldPollWelcomes(): boolean {
	return !(isNativePlatform() && document.visibilityState === 'hidden');
}

/**
 * One poll pass over the per-coordinator query cache (the same cache the
 * notifications dialog reads), then the auto-approve pass, then the
 * notifications. Order matters: awaiting the approval pass means a request the
 * admin's own setting just handled is never announced as still pending.
 */
export async function pollNotificationSources(): Promise<void> {
	if (!browser) return;
	const account = manager.active;
	if (!account) return;
	const coordinatorKeys = [...new Set(listKnownCoordinatorKeys())];
	if (coordinatorKeys.length === 0) return;
	const pollWelcomes = shouldPollWelcomes();

	notificationPollState.refreshing = true;
	try {
		const results = await Promise.allSettled(
			coordinatorKeys.map(async (key) => {
				await Promise.all([
					pollWelcomes
						? queryClient.fetchQuery(welcomeNotificationsQueryOptions(account.pubkey, key))
						: Promise.resolve(),
					queryClient.fetchQuery(joinRequestsQueryOptions(account.pubkey, key))
				]);
			})
		);
		notificationPollState.failures = results
			.map((result, index) =>
				// A not-yet-injected signer is transient and self-healing (the chat
				// layout already shows its waiting hint) — not coordinator noise.
				result.status === 'rejected' && !isSignerUnavailableError(result.reason)
					? `${getCoordinatorLabel(coordinatorKeys[index])}: ${errorText(result.reason)}`
					: ''
			)
			.filter(Boolean);
	} finally {
		notificationPollState.refreshing = false;
	}

	await autoApproveJoinRequests().catch(() => {});
	await notifyForJoinRequests().catch(() => {});
	if (pollWelcomes) await notifyForWelcomes().catch(() => {});
}

/**
 * Steady cadence: every 5 minutes, plus a catch-up poll when the app comes back
 * to the foreground (a backgrounded tab's interval is throttled). The immediate
 * poll is the chat layout's job — it must also fire when coordinators appear.
 * Returns a cleanup function — pass directly to onMount.
 */
export function startNotificationPolling(): () => void {
	if (!browser) return () => {};
	const run = () => void pollNotificationSources();
	const timer = setInterval(run, NOTIFICATION_POLL_INTERVAL_MS);
	const onVisibilityChange = () => {
		if (document.visibilityState === 'visible') run();
	};
	document.addEventListener('visibilitychange', onVisibilityChange);
	return () => {
		clearInterval(timer);
		document.removeEventListener('visibilitychange', onVisibilityChange);
	};
}
