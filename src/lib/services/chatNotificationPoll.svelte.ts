import { browser } from '$app/environment';
import { queryClient } from '$lib/query-client';
import { joinRequestsQueryOptions } from '$lib/queries/chatJoinRequestQueries';
import { welcomeNotificationsQueryOptions } from '$lib/queries/chatWelcomeQueries';
import { manager } from '$lib/services/accountManager.svelte';
import {
	notifyForApprovedJoinRequests,
	notifyForJoinRequests,
	notifyForWelcomes
} from '$lib/services/chatAttention.svelte';
import { autoApproveJoinRequests } from '$lib/services/chatAutoApprove.svelte';
import {
	getCoordinatorLabel,
	listKnownCoordinatorKeys
} from '$lib/services/chatCoordinators.svelte';
import { isSignerUnavailableError } from '$lib/services/chatRuntime';
import { canRunBackgroundWork, isNativePlatform } from '$lib/services/nativeBridge';
import { errorMessage as errorText, safeNormalizePubKey } from '$lib/utils';

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

let pollInFlight: Promise<void> | undefined;

/**
 * Single-flight: the interval, the visibility catch-up and the layout's
 * coordinator effect can all fire at once. Sharing one promise keeps the
 * request/welcome reads and the approval announcement from overlapping.
 */
export function pollNotificationSources(): Promise<void> {
	pollInFlight ??= runNotificationPoll().finally(() => {
		pollInFlight = undefined;
	});
	return pollInFlight;
}

/**
 * One poll pass over the per-coordinator query cache (the same cache the
 * notifications dialog reads). Each coordinator runs its own lane — refresh,
 * approve, announce — so a slow or offline coordinator never delays another's
 * approval or notification. Order within a lane matters: approving before
 * announcing means a request the admin's own setting just handled is never
 * announced as still pending.
 */
async function runNotificationPoll(): Promise<void> {
	if (!browser) return;
	if (!canRunBackgroundWork()) return;
	const account = manager.active;
	if (!account) return;
	// Normalized: a peer-derived key that is not valid hex cannot be addressed at
	// all, and would otherwise throw in the query key / label below.
	const coordinatorKeys = [...new Set(listKnownCoordinatorKeys().map(safeNormalizePubKey))].filter(
		Boolean
	);
	if (coordinatorKeys.length === 0) return;
	const pollWelcomes = shouldPollWelcomes();

	notificationPollState.refreshing = true;
	try {
		const results = await Promise.allSettled(
			coordinatorKeys.map((key) => runCoordinatorLane(account.pubkey, key, pollWelcomes))
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
}

/**
 * One coordinator's lane. Every step is scoped to this coordinator, so one
 * faulty coordinator cannot affect another's approvals or notifications.
 * A failed welcome read must not skip the signer-free approval, so the two
 * reads settle independently and the lane reports the failure afterwards.
 */
async function runCoordinatorLane(
	stablePubkey: string,
	coordinatorKey: string,
	pollWelcomes: boolean
): Promise<void> {
	const [welcomeFetch, joinFetch] = await Promise.allSettled([
		pollWelcomes
			? queryClient.fetchQuery(welcomeNotificationsQueryOptions(stablePubkey, coordinatorKey))
			: Promise.resolve(),
		queryClient.fetchQuery(joinRequestsQueryOptions(stablePubkey, coordinatorKey))
	]);
	const approved = await autoApproveJoinRequests(coordinatorKey).catch(() => []);
	await notifyForApprovedJoinRequests(approved).catch(() => {});
	await notifyForJoinRequests(coordinatorKey).catch(() => {});
	if (pollWelcomes) await notifyForWelcomes(coordinatorKey).catch(() => {});
	// Surfaced after the lane's own work: a failed read is reported, but it never
	// withholds the approval the join request already earned.
	if (joinFetch.status === 'rejected') throw joinFetch.reason;
	if (welcomeFetch.status === 'rejected') throw welcomeFetch.reason;
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
