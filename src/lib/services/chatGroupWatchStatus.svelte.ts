import { SvelteSet } from 'svelte/reactivity';
import { normalizePubKey } from '$lib/utils';

/**
 * Tiny, cycle-free registry of which group ids currently have an active live
 * subscription in `chatGroupWatch.svelte`.
 *
 * `chatGroups.svelte` reads `isGroupActivelyWatched()` to skip a redundant
 * coordinator catch-up fetch before sending an application message on a group
 * that is already kept current by its live subscription. Keeping this in its
 * own module avoids a circular import between `chatGroups` and `chatGroupWatch`
 * (the latter already imports the former).
 *
 * The source of truth for handles remains `currentWatches` in
 * `chatGroupWatch.svelte`; this set is only a read-only mirror maintained in
 * the same places the handle map is mutated.
 */

const watchedGroupIds = new SvelteSet<string>();

export function markGroupWatched(groupId: string): void {
	watchedGroupIds.add(groupId);
}

export function markGroupUnwatched(groupId: string): void {
	watchedGroupIds.delete(groupId);
}

export function markAllGroupsUnwatched(): void {
	watchedGroupIds.clear();
}

export function isGroupActivelyWatched(groupId: string): boolean {
	return watchedGroupIds.has(groupId);
}

/**
 * Mirror of the in-flight resume promise from `chatGroupWatch.svelte`, tagged
 * with the coordinator it is scoped to (if any).
 *
 * Outbound message sends read `getChatGroupResumePromise(coordinatorKey)` so
 * they can wait for an in-progress rebuild (the "Updating chats…" window) to
 * settle before touching group state, instead of racing the teardown/backlog
 * fetch and failing. A scoped resume only tears down one coordinator's
 * watches, so a send on a different (healthy) coordinator is not blocked by
 * it; a global resume can affect any coordinator and blocks all. Lives here
 * for the same cycle-avoidance reason as `watchedGroupIds`: `chatGroups.svelte`
 * can read it without importing `chatGroupWatch.svelte`.
 */
let currentResumePromise: Promise<void> | null = null;
let currentResumeCoordinatorKey: string | undefined = undefined;

export function setChatGroupResumePromise(
	promise: Promise<void> | null,
	coordinatorKey?: string
): void {
	currentResumePromise = promise;
	currentResumeCoordinatorKey =
		promise && coordinatorKey ? normalizePubKey(coordinatorKey) : undefined;
}

export function getChatGroupResumePromise(coordinatorKey?: string): Promise<void> | null {
	if (!currentResumePromise) return null;
	// A global resume (no scope) can restart any coordinator's watches.
	if (currentResumeCoordinatorKey === undefined) return currentResumePromise;
	// A scoped resume only affects the coordinator it is scoped to.
	if (coordinatorKey && normalizePubKey(coordinatorKey) === currentResumeCoordinatorKey) {
		return currentResumePromise;
	}
	return null;
}
