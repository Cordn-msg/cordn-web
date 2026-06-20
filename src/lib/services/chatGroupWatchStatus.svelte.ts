import { SvelteSet } from 'svelte/reactivity';

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
 * Mirror of the in-flight resume promise from `chatGroupWatch.svelte`.
 *
 * Outbound message sends read `getChatGroupResumePromise()` so they can wait
 * for an in-progress rebuild (the "Updating chats…" window) to settle before
 * touching group state, instead of racing the teardown/backlog fetch and
 * failing. Lives here for the same cycle-avoidance reason as `watchedGroupIds`:
 * `chatGroups.svelte` can read it without importing `chatGroupWatch.svelte`.
 */
let currentResumePromise: Promise<void> | null = null;

export function setChatGroupResumePromise(promise: Promise<void> | null): void {
	currentResumePromise = promise;
}

export function getChatGroupResumePromise(): Promise<void> | null {
	return currentResumePromise;
}
