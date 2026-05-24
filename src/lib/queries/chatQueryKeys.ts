import { normalizePubKey } from '$lib/utils';

const allCoordinators = 'all-coordinators';

export function normalizeQueryCoordinatorKey(coordinatorKey?: string): string {
	return coordinatorKey?.trim() ? normalizePubKey(coordinatorKey) : allCoordinators;
}

export const chatQueryKeys = {
	all: ['chat'] as const,
	account: (stablePubkey: string) =>
		[...chatQueryKeys.all, 'account', normalizePubKey(stablePubkey)] as const,
	coordinators: (stablePubkey: string) =>
		[...chatQueryKeys.account(stablePubkey), 'coordinators'] as const,
	coordinator: (stablePubkey: string, coordinatorKey?: string) =>
		[
			...chatQueryKeys.coordinators(stablePubkey),
			normalizeQueryCoordinatorKey(coordinatorKey)
		] as const,
	availableKeyPackages: (stablePubkey: string, coordinatorKey?: string) =>
		[...chatQueryKeys.coordinator(stablePubkey, coordinatorKey), 'available-key-packages'] as const,
	welcomeNotifications: (stablePubkey: string, coordinatorKey?: string) =>
		[...chatQueryKeys.coordinator(stablePubkey, coordinatorKey), 'welcome-notifications'] as const
} as const;
