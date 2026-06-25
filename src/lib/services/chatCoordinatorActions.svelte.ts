import { manager } from '$lib/services/accountManager.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { removeChatCoordinator } from '$lib/services/chatCoordinators.svelte';
import { deleteChatGroupsForCoordinator, listChatGroups } from '$lib/services/chatGroups.svelte';
import {
	listChatKeyPackages,
	purgeCoordinatorKeyPackages
} from '$lib/services/chatKeyPackages.svelte';
import {
	chatWelcomeNotificationsStore,
	deleteWelcomeNotificationsForCoordinator
} from '$lib/services/chatWelcomeNotifications.svelte';
import { disconnectCoordinatorClient } from '$lib/services/chatRuntime';
import { stopWatchingGroup } from '$lib/services/chatGroupWatch.svelte';
import { normalizePubKey } from '$lib/utils';

export interface CoordinatorPurgeImpact {
	groups: number;
	/** Still published to this coordinator — removed remotely + pruned locally. */
	keyPackagesPublished: number;
	/** Consumed local records (used to join this coordinator's groups) — deleted. */
	keyPackagesLocal: number;
	welcomes: number;
}

/**
 * Single source of truth for which local key package records a coordinator
 * purge must delete. Reads the immutable join-time link
 * (`group.joinedWithKeyPackageRef`) — the only surviving signal, since the MLS
 * protocol consumes the key package bytes and the ref is an irreversible hash.
 *
 * `willDelete` is scoped to this coordinator: a record is dropped only if it is
 * published here or consumed by a group here AND has no remaining purpose
 * (published to another coordinator / referenced by a surviving group).
 */
export function computeKeyPackageDeletion(coordinatorKey: string) {
	const normalized = normalizePubKey(coordinatorKey);
	const ownerPubkey = manager.getActive()?.pubkey;

	const allGroups = listChatGroups();
	const consumedHere = allGroups
		.filter((group) => group.coordinatorKey === normalized)
		.map((group) => group.joinedWithKeyPackageRef)
		.filter((ref): ref is string => Boolean(ref));
	const survivingGroupRefs = allGroups
		.filter((group) => group.coordinatorKey !== normalized)
		.map((group) => group.joinedWithKeyPackageRef)
		.filter((ref): ref is string => Boolean(ref));

	const published: string[] = [];
	const consumed: string[] = [];
	const willDelete: string[] = [];
	for (const entry of listChatKeyPackages(ownerPubkey)) {
		const isPublishedHere = entry.publishedCoordinatorKeys.includes(normalized);
		const isConsumedHere = consumedHere.includes(entry.keyPackageRef);
		if (!isPublishedHere && !isConsumedHere) continue;
		if (isPublishedHere) published.push(entry.keyPackageRef);
		if (isConsumedHere) consumed.push(entry.keyPackageRef);
		const stillUsefulElsewhere =
			entry.publishedCoordinatorKeys.some((key) => key !== normalized) ||
			survivingGroupRefs.includes(entry.keyPackageRef);
		if (!stillUsefulElsewhere) willDelete.push(entry.keyPackageRef);
	}
	return { published, consumed, willDelete };
}

/**
 * Cheap read used by the confirmation dialog copy. Reflects current local state
 * for the active account.
 */
export function getCoordinatorPurgeImpact(coordinatorKey: string): CoordinatorPurgeImpact {
	const normalized = normalizePubKey(coordinatorKey);
	const { published, consumed } = computeKeyPackageDeletion(normalized);
	return {
		groups: listChatGroups().filter((group) => group.coordinatorKey === normalized).length,
		keyPackagesPublished: published.length,
		keyPackagesLocal: consumed.length,
		welcomes: chatWelcomeNotificationsStore.entries.filter(
			(entry) => entry.coordinatorKey === normalized
		).length
	};
}

/**
 * Delete everything local tied to a coordinator: its profile, groups, key
 * packages published to it (remote + local, with now-orphaned local records
 * dropped), welcome notifications, the live client connection, and the
 * coordinator-scoped Svelte Query cache. Semantics: "delete coordinator" means
 * delete all records associated with it.
 */
export async function purgeChatCoordinator(coordinatorKey: string): Promise<void> {
	const normalized = normalizePubKey(coordinatorKey);
	const account = manager.getActive();

	// Resolve KP deletion BEFORE groups vanish — joinedWithKeyPackageRef is the
	// attribution link and must be read while the groups still exist.
	const { willDelete } = computeKeyPackageDeletion(normalized);

	const groupIds = listChatGroups()
		.filter((group) => group.coordinatorKey === normalized)
		.map((group) => group.id);
	await Promise.all(groupIds.map((id) => stopWatchingGroup(id, 'coordinator purged')));

	await deleteChatGroupsForCoordinator(normalized);
	await purgeCoordinatorKeyPackages(normalized, willDelete);
	deleteWelcomeNotificationsForCoordinator(normalized);
	removeChatCoordinator(normalized);

	if (account) {
		await disconnectCoordinatorClient(account, normalized).catch(() => {});
		queryClient.removeQueries({
			queryKey: chatQueryKeys.coordinator(account.pubkey, normalized)
		});
	}
}
