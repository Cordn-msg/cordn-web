import { createQuery } from '@tanstack/svelte-query';
import { browser } from '$app/environment';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { isCoordinatorClientRefreshInProgress } from '$lib/services/chatRuntime';
import { listKnownCoordinatorKeys } from '$lib/services/chatCoordinators.svelte';
import {
	fetchWelcomeNotifications,
	listWelcomeNotificationsForCoordinator,
	listWelcomeNotifications
} from '$lib/services/chatWelcomeNotifications.svelte';
import { normalizePubKey } from '$lib/utils';

async function fetchSingleCoordinatorWelcomeNotifications(coordinatorKey: string) {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	await fetchWelcomeNotifications([normalizedCoordinatorKey]);
	return listWelcomeNotificationsForCoordinator(normalizedCoordinatorKey);
}

export async function fetchCoordinatorWelcomeNotifications(
	stablePubkey: string,
	coordinatorKey?: string,
	options?: {
		force?: boolean;
	}
) {
	if (coordinatorKey?.trim()) {
		return fetchSingleCoordinatorWelcomeNotifications(coordinatorKey);
	}

	const coordinatorKeys = [...new Set(listKnownCoordinatorKeys().map(normalizePubKey))];
	const staleTime = options?.force ? 0 : 60 * 1000;
	await Promise.allSettled(
		coordinatorKeys.map((key) =>
			queryClient.fetchQuery({
				queryKey: chatQueryKeys.welcomeNotifications(stablePubkey, key),
				queryFn: () => fetchSingleCoordinatorWelcomeNotifications(key),
				staleTime
			})
		)
	);

	return listWelcomeNotifications();
}

// Welcome notifications are a Query-managed remote read (AGENTS.md). The
// pubkey is read via a getter (see useWelcomeNotifications) so the query
// re-evaluates on login/logout — a plain arg is captured once at mount, which
// leaves always-mounted consumers (ChatActionIcons, the panels) stuck
// pre-login. Disabled until an account is present.
export function welcomeNotificationsQueryOptions(stablePubkey: string, coordinatorKey?: string) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	return {
		queryKey: hasStablePubkey
			? chatQueryKeys.welcomeNotifications(stablePubkey, coordinatorKey)
			: ([...chatQueryKeys.all, 'welcome-notifications', 'no-account'] as const),
		queryFn: () => fetchCoordinatorWelcomeNotifications(stablePubkey, coordinatorKey),
		enabled: browser && hasStablePubkey && !isCoordinatorClientRefreshInProgress(),
		staleTime: 60 * 1000,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: false
	};
}

export function useWelcomeNotifications(
	getStablePubkey: () => string | undefined,
	coordinatorKey?: string
) {
	return createQuery(() =>
		welcomeNotificationsQueryOptions(getStablePubkey() ?? '', coordinatorKey)
	);
}
