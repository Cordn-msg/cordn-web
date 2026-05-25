import { createQuery } from '@tanstack/svelte-query';
import { browser } from '$app/environment';
import { queryClient } from '$lib/query-client';
import type { AvailableKeyPackage } from '$lib/contracts';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { listChatCoordinators } from '$lib/services/chatCoordinators.svelte';
import { getCoordinatorClient, requireActiveAccount } from '$lib/services/chatRuntime';
import { normalizePubKey } from '$lib/utils';

async function fetchSingleCoordinatorAvailableKeyPackages(
	coordinatorKey: string
): Promise<AvailableKeyPackage[]> {
	const account = requireActiveAccount('You must be logged in to list coordinator key packages');
	const client = getCoordinatorClient(account, normalizePubKey(coordinatorKey));
	const result = await client.ListAvailableKeyPackages({});
	return result.keyPackages.sort((a, b) => b.at - a.at);
}

export async function fetchCoordinatorAvailableKeyPackages(
	coordinatorKey?: string,
	options: { force?: boolean } = {}
): Promise<AvailableKeyPackage[]> {
	const account = requireActiveAccount('You must be logged in to list coordinator key packages');
	if (coordinatorKey?.trim()) {
		return fetchSingleCoordinatorAvailableKeyPackages(coordinatorKey);
	}

	const coordinatorKeys = [
		...new Set(listChatCoordinators().map((entry) => normalizePubKey(entry.pubkey)))
	];

	const results = await Promise.all(
		coordinatorKeys.map((key) =>
			queryClient.fetchQuery({
				queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, key),
				queryFn: () => fetchSingleCoordinatorAvailableKeyPackages(key),
				staleTime: options.force ? 0 : 30 * 1000
			})
		)
	);

	return results.flat().sort((a, b) => b.at - a.at);
}

export function availableKeyPackagesQueryOptions(stablePubkey: string, coordinatorKey?: string) {
	return {
		queryKey: chatQueryKeys.availableKeyPackages(stablePubkey, coordinatorKey),
		queryFn: () => fetchCoordinatorAvailableKeyPackages(coordinatorKey),
		enabled: browser && Boolean(stablePubkey),
		staleTime: 30 * 1000
	};
}

export function useAvailableKeyPackages(stablePubkey: string, coordinatorKey?: string) {
	return createQuery(() => availableKeyPackagesQueryOptions(stablePubkey, coordinatorKey));
}
