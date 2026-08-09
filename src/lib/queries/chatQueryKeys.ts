import { normalizePubKey } from '$lib/utils';

const allCoordinators = 'all-coordinators';

export function normalizeQueryCoordinatorKey(coordinatorKey?: string): string {
	return coordinatorKey?.trim() ? normalizePubKey(coordinatorKey) : allCoordinators;
}

export const chatQueryKeys = {
	all: ['chat'] as const,
	// `hints` is part of the key so an nprofile/NIP-05 deep link (which carries
	// relay hints) dedups separately from the default metadataRelays lookup.
	profile: (pubkey: string, hints: readonly string[] = []) =>
		[...chatQueryKeys.all, 'profile', normalizePubKey(pubkey), hints] as const,
	userRelayList: (pubkey: string) =>
		[...chatQueryKeys.all, 'user-relay-list', normalizePubKey(pubkey)] as const,
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
