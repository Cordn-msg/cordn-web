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

/** Wall-clock ms of the last message chunk the live stream delivered per group.
 * The MD send path reads this as its proof the feed is alive-and-delivering
 * (see `isGroupFeedLive`); a plain Map, not reactive — only read at send time. */
const groupFeedLastChunkAt = new Map<string, number>();

/** Groups whose most recent backlog fetch failed. A failed backlog leaves a
 * hole the live stream cannot fill (it only delivers post-subscribe
 * arrivals), so feed liveness alone must not vouch for state completeness
 * until some fetch succeeds (watch restart or the heartbeat catch-up) — see
 * the mark call sites in chatGroupWatch.svelte. */
const groupBacklogIncomplete = new Set<string>();

/** How recent a delivered chunk keeps a feed considered "live" for the MD
 * send-path catch-up skip. Short on purpose: the skip's residual risk is a
 * sibling message landing inside this window after silent stream death, and
 * active conversations re-stamp it on every message. */
const GROUP_FEED_LIVE_MS = 5_000;

export function markGroupFeedLive(groupId: string): void {
	groupFeedLastChunkAt.set(groupId, Date.now());
}

export function markGroupsBacklogComplete(groupIds: string[]): void {
	for (const groupId of groupIds) groupBacklogIncomplete.delete(groupId);
}

export function markGroupsBacklogIncomplete(groupIds: string[]): void {
	for (const groupId of groupIds) groupBacklogIncomplete.add(groupId);
}

export function isGroupFeedLive(groupId: string): boolean {
	const lastChunkAt = groupFeedLastChunkAt.get(groupId);
	return (
		!groupBacklogIncomplete.has(groupId) &&
		lastChunkAt !== undefined &&
		Date.now() - lastChunkAt < GROUP_FEED_LIVE_MS
	);
}

export function markGroupWatched(groupId: string): void {
	watchedGroupIds.add(groupId);
}

export function markGroupUnwatched(groupId: string): void {
	watchedGroupIds.delete(groupId);
	groupFeedLastChunkAt.delete(groupId);
}

export function markAllGroupsUnwatched(): void {
	watchedGroupIds.clear();
	groupFeedLastChunkAt.clear();
	groupBacklogIncomplete.clear();
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
 * failing. Lives here for the same cycle-avoidance reason as
 * `watchedGroupIds`: `chatGroups.svelte` can read it without importing
 * `chatGroupWatch.svelte`.
 */
let currentResumePromise: Promise<void> | null = null;

export function setChatGroupResumePromise(promise: Promise<void> | null): void {
	currentResumePromise = promise;
}

export function getChatGroupResumePromise(): Promise<void> | null {
	return currentResumePromise;
}
