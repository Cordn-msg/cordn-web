import { encodeGroupRef } from '@cordn/core';
import { getChatGroup } from './chatGroups.svelte';
import { getChatCoordinator } from './chatCoordinators.svelte';
import { normalizePubKey } from '$lib/utils';

/**
 * The canonical route-id string for a group's `[id]` path segment: a `cordn1`
 * ref when the group is known locally (so its coordinator + relay hints can be
 * encoded for portability), falling back to the bare gid for groups we don't
 * have (the `[id]` route accepts both forms via `resolveGroupLocator`).
 *
 * Single source of truth for the id segment of internal navigation + permalinks,
 * so every internal link produces `cordn1` at the source instead of a bare gid
 * that a route layer would have to rewrite after the fact. Pair with
 * `resolve('/chat/[id]', { id: groupRouteId(gid) })` at each call site so the
 * path stays type-checked and the `svelte/no-navigation-without-resolve` rule
 * can see the `resolve()`.
 */
export function groupRouteId(groupId: string): string {
	const coordinatorKey = getChatGroup(groupId)?.coordinatorKey;
	if (!coordinatorKey) return groupId;
	const relays = getChatCoordinator(coordinatorKey)?.relays;
	return encodeGroupRef(
		relays && relays.length > 0
			? { gid: groupId, coordinatorPubkey: normalizePubKey(coordinatorKey), relays }
			: { gid: groupId, coordinatorPubkey: normalizePubKey(coordinatorKey) }
	);
}
