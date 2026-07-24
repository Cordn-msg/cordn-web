import { normalizePubKey } from '$lib/utils';

const allCoordinators = 'all-coordinators';

export function normalizeQueryCoordinatorKey(coordinatorKey?: string): string {
	return coordinatorKey?.trim() ? normalizePubKey(coordinatorKey) : allCoordinators;
}

export const chatQueryKeys = {
	all: ['chat'] as const,
	profile: (pubkey: string) => [...chatQueryKeys.all, 'profile', normalizePubKey(pubkey)] as const,
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
		[...chatQueryKeys.coordinator(stablePubkey, coordinatorKey), 'welcome-notifications'] as const,
	joinRequests: (stablePubkey: string, coordinatorKey?: string) =>
		[...chatQueryKeys.coordinator(stablePubkey, coordinatorKey), 'join-requests'] as const,
	/**
	 * NIP-05 / shortname → pubkey resolution. This is a public DNS lookup
	 * (`.well-known/nostr.json`), identical for every account, so it is
	 * deliberately NOT scoped under account(...) — unlike the private remote
	 * reads above (AGENTS.md).
	 */
	profileIdentifier: (identifier: string) =>
		[...chatQueryKeys.all, 'profile-identifier', identifier.trim().toLowerCase()] as const
} as const;
