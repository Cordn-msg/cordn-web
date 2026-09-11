import { browser } from '$app/environment';
import type { QueryFunctionContext } from '@tanstack/svelte-query';
import { queryClient } from '$lib/query-client';
import type { AvailableKeyPackage } from '$lib/contracts';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import {
	getChatCoordinator,
	listKnownCoordinatorKeys
} from '$lib/services/chatCoordinators.svelte';
import { cordnClient } from '$lib/services/coordinatorClient';
import { throwIfCoordinatorInReadBackoff } from '$lib/services/coordinatorHealth.svelte';
import { defaultRelays } from '$lib/services/relay-pool';
import { requireActiveAccount, withCoordinatorClient } from '$lib/services/chatRuntime';
import { normalizePubKey } from '$lib/utils';

async function fetchSingleCoordinatorAvailableKeyPackages(
	coordinatorKey: string,
	options: { signal?: AbortSignal; force?: boolean } = {}
): Promise<AvailableKeyPackage[]> {
	const account = requireActiveAccount('You must be logged in to list coordinator key packages');
	// Passive polls respect outage backoff; an explicit refresh may probe now.
	if (!options.force) throwIfCoordinatorInReadBackoff(coordinatorKey);
	const result = await withCoordinatorClient(
		account,
		normalizePubKey(coordinatorKey),
		(client) => client.ListAvailableKeyPackages({}),
		{ signal: options.signal }
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
	options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<AvailableKeyPackageWithCoordinator[]> {
	const account = requireActiveAccount('You must be logged in to list coordinator key packages');
	if (coordinatorKey?.trim()) {
		const entries = await fetchSingleCoordinatorAvailableKeyPackages(coordinatorKey, options);
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
					queryFn: ({ signal }) =>
						fetchSingleCoordinatorAvailableKeyPackages(key, { signal, force: options.force }),
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

// Available key packages are a Query-managed remote read (AGENTS.md), observed
// per coordinator: each coordinator resolves independently (createQueries at
// the consumers) and aggregation is a derived value, so one faulty
// coordinator can't stall the directory. Pass a coordinator key for the
// per-coordinator observer; without one this is the imperative fan-out used
// by startup/refresh (its result merges all legs). Disabled until an account
// is present.
export function availableKeyPackagesQueryOptions(stablePubkey: string, coordinatorKey?: string) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	return {
		queryKey: hasStablePubkey
			? chatQueryKeys.availableKeyPackages(stablePubkey, coordinatorKey)
			: ([
					...chatQueryKeys.all,
					'available-key-packages',
					'no-account',
					coordinatorKey ?? 'any'
				] as const),
		queryFn: ({ signal }: QueryFunctionContext) =>
			fetchCoordinatorAvailableKeyPackages(coordinatorKey, { signal }),
		enabled: browser && hasStablePubkey,
		staleTime: 60 * 1000,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: false
	};
}
