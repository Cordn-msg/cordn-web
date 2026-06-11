import { createQuery } from '@tanstack/svelte-query';
import { browser } from '$app/environment';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { manager } from '$lib/services/accountManager.svelte';
import { isCoordinatorClientRefreshInProgress } from '$lib/services/chatRuntime';
import {
	fetchWelcomeNotifications,
	listKnownCoordinatorKeys,
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

export function welcomeNotificationsQueryOptions(stablePubkey: string, coordinatorKey?: string) {
	const hasStablePubkey = Boolean(stablePubkey?.trim());
	const hasActiveAccount = Boolean(manager.getActive());
	const canFetchWelcomes = !isCoordinatorClientRefreshInProgress();
	return {
		queryKey: chatQueryKeys.welcomeNotifications(stablePubkey, coordinatorKey),
		queryFn: () => fetchCoordinatorWelcomeNotifications(stablePubkey, coordinatorKey),
		enabled: browser && hasStablePubkey && hasActiveAccount && canFetchWelcomes,
		staleTime: 60 * 1000,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: false
	};
}

export function useWelcomeNotifications(stablePubkey?: string, coordinatorKey?: string) {
	if (!stablePubkey) return undefined;
	return createQuery(() => welcomeNotificationsQueryOptions(stablePubkey, coordinatorKey));
}
