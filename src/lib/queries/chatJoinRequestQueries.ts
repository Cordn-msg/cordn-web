import { createQuery } from '@tanstack/svelte-query';
import { browser } from '$app/environment';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { manager } from '$lib/services/accountManager.svelte';
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

export function joinRequestsQueryOptions(stablePubkey: string, coordinatorKey?: string) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	const hasActiveAccount = Boolean(manager.getActive());
	const canFetch = !isCoordinatorClientRefreshInProgress();
	return {
		queryKey: chatQueryKeys.joinRequests(stablePubkey, coordinatorKey),
		queryFn: () => fetchCoordinatorJoinRequests(stablePubkey, coordinatorKey),
		enabled: browser && hasStablePubkey && hasActiveAccount && canFetch,
		staleTime: 60 * 1000,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: false
	};
}

export function useJoinRequests(stablePubkey?: string, coordinatorKey?: string) {
	if (!stablePubkey) return undefined;
	return createQuery(() => joinRequestsQueryOptions(stablePubkey, coordinatorKey));
}
