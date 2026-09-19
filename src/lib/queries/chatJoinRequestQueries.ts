import { untrack } from 'svelte';
import type { QueryFunctionContext } from '@tanstack/svelte-query';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { listKnownCoordinatorKeys } from '$lib/services/chatCoordinators.svelte';
import { requireActiveAccount } from '$lib/services/chatRuntime';
import {
	fetchJoinRequestsForAdminGroups,
	listJoinRequests,
	listJoinRequestsForCoordinator
} from '$lib/services/chatJoinRequests.svelte';
import { normalizePubKey } from '$lib/utils';

/** Imperative reads share the same per-coordinator cache as mounted observers. */
export async function fetchCoordinatorJoinRequests(options: { force?: boolean } = {}) {
	const account = requireActiveAccount('You must be logged in to fetch join requests');
	await Promise.allSettled(
		listKnownCoordinatorKeys().map((key) =>
			queryClient.fetchQuery(joinRequestsQueryOptions(account.pubkey, key, options))
		)
	);
	return listJoinRequests();
}

export function joinRequestsQueryOptions(
	stablePubkey: string,
	coordinatorKey: string,
	options: { force?: boolean } = {}
) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	return {
		queryKey: hasStablePubkey
			? chatQueryKeys.joinRequests(stablePubkey, normalizedCoordinatorKey)
			: ([...chatQueryKeys.all, 'join-requests', 'no-account', normalizedCoordinatorKey] as const),
		queryFn: async ({ signal }: QueryFunctionContext) =>
			// untrack: see welcomeNotificationsQueryOptions — reactive reads before
			// the first await must not become deps of the calling effect
			// (TanStack/query#11541).
			untrack(async () => {
				await fetchJoinRequestsForAdminGroups(normalizedCoordinatorKey, {
					signal,
					force: options.force
				});
				return listJoinRequestsForCoordinator(normalizedCoordinatorKey);
			}),
		// No observer ever mounts these options (the dialog polls imperatively via
		// fetchQuery and reads the stores), so observer-only config is inert here.
		// staleTime is the one option fetchQuery honors: it dedups burst polls.
		staleTime: options.force ? 0 : 60 * 1000
	};
}
