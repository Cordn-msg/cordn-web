import { createQuery } from '@tanstack/svelte-query';
import { browser } from '$app/environment';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
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
	await Promise.all(
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
	return {
		queryKey: hasStablePubkey
			? chatQueryKeys.welcomeNotifications(stablePubkey, coordinatorKey)
			: [...chatQueryKeys.all, 'inactive-account', 'welcome-notifications'],
		queryFn: () => fetchCoordinatorWelcomeNotifications(stablePubkey, coordinatorKey),
		enabled: browser && hasStablePubkey,
		staleTime: 60 * 1000,
		refetchOnWindowFocus: true,
		refetchInterval: 5 * 60 * 1000,
		refetchIntervalInBackground: true
	};
}

export function useWelcomeNotifications(
	stablePubkey: string | (() => string),
	coordinatorKey?: string | (() => string | undefined)
) {
	return createQuery(() =>
		welcomeNotificationsQueryOptions(
			typeof stablePubkey === 'function' ? stablePubkey() : stablePubkey,
			typeof coordinatorKey === 'function' ? coordinatorKey() : coordinatorKey
		)
	);
}
