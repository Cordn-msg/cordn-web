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
	coordinatorKey?: string
) {
	if (coordinatorKey?.trim()) {
		return fetchSingleCoordinatorWelcomeNotifications(coordinatorKey);
	}

	const coordinatorKeys = [...new Set(listKnownCoordinatorKeys().map(normalizePubKey))];
	await Promise.all(
		coordinatorKeys.map((key) =>
			queryClient.fetchQuery({
				queryKey: chatQueryKeys.welcomeNotifications(stablePubkey, key),
				queryFn: () => fetchSingleCoordinatorWelcomeNotifications(key),
				staleTime: 60 * 1000
			})
		)
	);

	return listWelcomeNotifications();
}

export function welcomeNotificationsQueryOptions(stablePubkey: string, coordinatorKey?: string) {
	return {
		queryKey: chatQueryKeys.welcomeNotifications(stablePubkey, coordinatorKey),
		queryFn: () => fetchCoordinatorWelcomeNotifications(stablePubkey, coordinatorKey),
		enabled: browser && Boolean(stablePubkey),
		staleTime: 60 * 1000,
		refetchOnWindowFocus: true
	};
}

export function useWelcomeNotifications(stablePubkey: string, coordinatorKey?: string) {
	return createQuery(() => welcomeNotificationsQueryOptions(stablePubkey, coordinatorKey));
}
