import { browser } from '$app/environment';
import type { QueryFunctionContext } from '@tanstack/svelte-query';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { listKnownCoordinatorKeys } from '$lib/services/chatCoordinators.svelte';
import {
	fetchWelcomeNotifications,
	listWelcomeNotifications,
	listWelcomeNotificationsForCoordinator
} from '$lib/services/chatWelcomeNotifications.svelte';
import { normalizePubKey } from '$lib/utils';

async function fetchSingleCoordinatorWelcomeNotifications(
	coordinatorKey: string,
	options: { signal?: AbortSignal; force?: boolean } = {}
) {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	await fetchWelcomeNotifications([normalizedCoordinatorKey], options);
	return listWelcomeNotificationsForCoordinator(normalizedCoordinatorKey);
}

/**
 * Fetch one (or, with no key, every) known coordinator's welcome notifications
 * through the per-coordinator query cache. Legs run concurrently and merge into
 * the welcome store as they land, so one slow/dead coordinator never gates the
 * others — the awaited result is only for imperative callers (startup, refresh).
 */
export async function fetchCoordinatorWelcomeNotifications(
	stablePubkey: string,
	coordinatorKey?: string,
	options?: {
		force?: boolean;
	}
) {
	const staleTime = options?.force ? 0 : 60 * 1000;
	if (coordinatorKey?.trim()) {
		return queryClient.fetchQuery({
			queryKey: chatQueryKeys.welcomeNotifications(stablePubkey, coordinatorKey),
			queryFn: ({ signal }) =>
				fetchSingleCoordinatorWelcomeNotifications(coordinatorKey, {
					signal,
					force: options?.force
				}),
			staleTime
		});
	}

	const coordinatorKeys = [...new Set(listKnownCoordinatorKeys().map(normalizePubKey))];
	await Promise.allSettled(
		coordinatorKeys.map((key) =>
			queryClient.fetchQuery({
				queryKey: chatQueryKeys.welcomeNotifications(stablePubkey, key),
				queryFn: ({ signal }) =>
					fetchSingleCoordinatorWelcomeNotifications(key, { signal, force: options?.force }),
				staleTime
			})
		)
	);

	return listWelcomeNotifications();
}

// Welcome notifications are a Query-managed remote read (AGENTS.md), observed
// per coordinator: each coordinator resolves on its own schedule and merges
// into the welcome store as it lands — a faulty coordinator can't stall the
// rest. Disabled until an account is present.
export function welcomeNotificationsQueryOptions(stablePubkey: string, coordinatorKey: string) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	return {
		queryKey: hasStablePubkey
			? chatQueryKeys.welcomeNotifications(stablePubkey, coordinatorKey)
			: ([...chatQueryKeys.all, 'welcome-notifications', 'no-account', coordinatorKey] as const),
		queryFn: ({ signal }: QueryFunctionContext) =>
			fetchSingleCoordinatorWelcomeNotifications(coordinatorKey, { signal }),
		enabled: browser && hasStablePubkey,
		staleTime: 60 * 1000,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: false
	};
}
