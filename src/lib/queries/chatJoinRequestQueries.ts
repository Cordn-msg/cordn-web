import { createQuery } from '@tanstack/svelte-query';
import { browser } from '$app/environment';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { isCoordinatorClientRefreshInProgress } from '$lib/services/chatRuntime';
import {
	fetchJoinRequestsForAdminGroups,
	listJoinRequests,
	listJoinRequestsForCoordinator
} from '$lib/services/chatJoinRequests.svelte';
import { normalizePubKey } from '$lib/utils';

async function fetchSingleCoordinatorJoinRequests(coordinatorKey: string) {
	await fetchJoinRequestsForAdminGroups();
	return listJoinRequestsForCoordinator(normalizePubKey(coordinatorKey));
}

export async function fetchCoordinatorJoinRequests(_stablePubkey: string, coordinatorKey?: string) {
	if (coordinatorKey?.trim()) {
		return fetchSingleCoordinatorJoinRequests(coordinatorKey);
	}

	await fetchJoinRequestsForAdminGroups();
	return listJoinRequests();
}

// Join requests are a Query-managed remote read (AGENTS.md). The pubkey is
// read via a getter (see useJoinRequests) so the query re-evaluates on
// login/logout — a plain arg is captured once at mount, which leaves
// always-mounted consumers (ChatActionIcons, the panels) stuck pre-login.
// Disabled until an account is present.
export function joinRequestsQueryOptions(stablePubkey: string, coordinatorKey?: string) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	return {
		queryKey: hasStablePubkey
			? chatQueryKeys.joinRequests(stablePubkey, coordinatorKey)
			: ([...chatQueryKeys.all, 'join-requests', 'no-account'] as const),
		queryFn: () => fetchCoordinatorJoinRequests(stablePubkey, coordinatorKey),
		enabled: browser && hasStablePubkey && !isCoordinatorClientRefreshInProgress(),
		staleTime: 60 * 1000,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: false
	};
}

export function useJoinRequests(
	getStablePubkey: () => string | undefined,
	coordinatorKey?: string
) {
	return createQuery(() => joinRequestsQueryOptions(getStablePubkey() ?? '', coordinatorKey));
}
