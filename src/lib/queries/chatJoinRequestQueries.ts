import { browser } from '$app/environment';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { isCoordinatorClientRefreshInProgress } from '$lib/services/chatRuntime';
import {
	fetchJoinRequestsForAdminGroups,
	listJoinRequests,
	listJoinRequestsForCoordinator
} from '$lib/services/chatJoinRequests.svelte';
import { normalizePubKey } from '$lib/utils';

/**
 * Imperative sync (startup, pull-to-refresh): fetch every coordinator's admin
 * group join requests concurrently; legs merge into the store as they land, so
 * one slow/dead coordinator never gates the others.
 */
export async function fetchCoordinatorJoinRequests() {
	await fetchJoinRequestsForAdminGroups();
	return listJoinRequests();
}

// Join requests are a Query-managed remote read (AGENTS.md), observed per
// coordinator: each coordinator resolves on its own schedule and merges into
// the join-requests store as it lands — a faulty coordinator can't stall the
// rest. Disabled until an account is present.
export function joinRequestsQueryOptions(stablePubkey: string, coordinatorKey: string) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	return {
		queryKey: hasStablePubkey
			? chatQueryKeys.joinRequests(stablePubkey, normalizedCoordinatorKey)
			: ([...chatQueryKeys.all, 'join-requests', 'no-account', normalizedCoordinatorKey] as const),
		queryFn: async () => {
			await fetchJoinRequestsForAdminGroups(normalizedCoordinatorKey);
			return listJoinRequestsForCoordinator(normalizedCoordinatorKey);
		},
		enabled:
			browser && hasStablePubkey && !isCoordinatorClientRefreshInProgress(normalizedCoordinatorKey),
		staleTime: 60 * 1000,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: false
	};
}
