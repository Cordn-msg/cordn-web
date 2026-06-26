import { createQuery } from '@tanstack/svelte-query';
import { browser } from '$app/environment';
import { queryClient } from '$lib/query-client';
import type { AvailableKeyPackage } from '$lib/contracts';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import {
	getChatCoordinator,
	listKnownCoordinatorKeys
} from '$lib/services/chatCoordinators.svelte';
import { cordnClient } from '$lib/services/coordinatorClient';
import { defaultRelays } from '$lib/services/relay-pool';
import {
	isCoordinatorClientRefreshInProgress,
	requireActiveAccount,
	withCoordinatorClient
} from '$lib/services/chatRuntime';
import { normalizePubKey } from '$lib/utils';

async function fetchSingleCoordinatorAvailableKeyPackages(
	coordinatorKey: string
): Promise<AvailableKeyPackage[]> {
	const account = requireActiveAccount('You must be logged in to list coordinator key packages');
	const result = await withCoordinatorClient(account, normalizePubKey(coordinatorKey), (client) =>
		client.ListAvailableKeyPackages({})
	);
	return result.keyPackages.sort((a, b) => b.at - a.at);
}

function resolveGuestCoordinatorRelays(coordinatorKey: string): string[] {
	const coordinator = getChatCoordinator(normalizePubKey(coordinatorKey));
	if (coordinator?.relays.length) {
		return coordinator.relays;
	}

	return defaultRelays;
}

export async function fetchPublicCoordinatorAvailableKeyPackages(
	coordinatorKey: string
): Promise<AvailableKeyPackageWithCoordinator[]> {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	const client = new cordnClient({
		serverPubkey: normalizedCoordinatorKey,
		relays: resolveGuestCoordinatorRelays(normalizedCoordinatorKey)
	});

	try {
		const result = await client.ListAvailableKeyPackages({});
		return result.keyPackages
			.map((entry) => ({ ...entry, coordinatorKey: normalizedCoordinatorKey }))
			.sort((a, b) => b.at - a.at);
	} finally {
		await client.disconnect().catch(() => undefined);
	}
}

export type AvailableKeyPackageWithCoordinator = AvailableKeyPackage & { coordinatorKey: string };

export async function fetchCoordinatorAvailableKeyPackages(
	coordinatorKey?: string,
	options: { force?: boolean } = {}
): Promise<AvailableKeyPackageWithCoordinator[]> {
	const account = requireActiveAccount('You must be logged in to list coordinator key packages');
	if (coordinatorKey?.trim()) {
		const entries = await fetchSingleCoordinatorAvailableKeyPackages(coordinatorKey);
		return entries.map((entry) => ({ ...entry, coordinatorKey }));
	}

	const coordinatorKeys = [
		...new Set(listKnownCoordinatorKeys().map((entry) => normalizePubKey(entry)))
	];

	const results = await Promise.allSettled(
		coordinatorKeys.map((key) =>
			queryClient
				.fetchQuery({
					queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, key),
					queryFn: () => fetchSingleCoordinatorAvailableKeyPackages(key),
					staleTime: options.force ? 0 : 30 * 1000
				})
				.then((entries) => entries.map((entry) => ({ ...entry, coordinatorKey: key })))
		)
	);

	return results
		.filter(
			(r): r is PromiseFulfilledResult<AvailableKeyPackageWithCoordinator[]> =>
				r.status === 'fulfilled'
		)
		.flatMap((r) => r.value)
		.sort((a, b) => b.at - a.at);
}

// Available key packages are a Query-managed remote read (AGENTS.md). The
// pubkey is read via a getter (see useAvailableKeyPackages) so the query
// re-evaluates on login/logout — a plain arg is captured once at mount, which
// leaves always-mounted consumers (the sidebar's NewConversationDialog) stuck
// pre-login. Disabled until an account is present.
export function availableKeyPackagesQueryOptions(stablePubkey: string, coordinatorKey?: string) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	return {
		queryKey: hasStablePubkey
			? chatQueryKeys.availableKeyPackages(stablePubkey, coordinatorKey)
			: ([...chatQueryKeys.all, 'available-key-packages', 'no-account'] as const),
		queryFn: () => fetchCoordinatorAvailableKeyPackages(coordinatorKey),
		enabled: browser && hasStablePubkey && !isCoordinatorClientRefreshInProgress(),
		staleTime: 60 * 1000,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: false
	};
}

export function useAvailableKeyPackages(
	getStablePubkey: () => string | undefined,
	coordinatorKey?: string
) {
	return createQuery(() =>
		availableKeyPackagesQueryOptions(getStablePubkey() ?? '', coordinatorKey)
	);
}
