import { browser } from '$app/environment';
import { manager } from '$lib/services/accountManager.svelte';
import {
	decodeStoredGroupState,
	getChatGroup,
	ingestIncomingChatGroupMessages,
	isChatGroupPoisoned,
	isChatGroupRemoved,
	listChatGroups,
	reloadChatGroupsForOwner
} from '$lib/services/chatGroups.svelte';
import {
	disconnectCoordinatorClients,
	getCoordinatorClient,
	isCurrentCoordinatorClient,
	isTransientCoordinatorError,
	replaceCoordinatorClient
} from '$lib/services/chatRuntime';
import type { IAccount } from 'applesauce-accounts';
import type { coordinatorClient } from '$lib/services/coordinatorClient';
import {
	clearChatReconnectStatus,
	failChatReconnectStatus,
	setChatReconnectStatus
} from '$lib/services/chatReconnectStatus.svelte';
import { markCoordinatorDegraded } from '$lib/services/coordinatorHealth.svelte';
import {
	awaitMultiDeviceReconciled,
	resetMultiDeviceSession
} from '$lib/services/multiDevice.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import {
	loadChatGroupPresenceForOwner,
	pruneChatGroupPresence
} from '$lib/services/chatGroupPresence.svelte';
import { loadWelcomeNotificationsForOwner } from '$lib/services/chatWelcomeNotifications.svelte';
import { loadJoinRequestsForOwner } from '$lib/services/chatJoinRequests.svelte';
import {
	advanceNativeCursor,
	groupFetchWatermark,
	isNativePlatform
} from '$lib/services/nativeBridge';
import {
	markAllGroupsUnwatched,
	markGroupUnwatched,
	markGroupWatched,
	setChatGroupResumePromise
} from '$lib/services/chatGroupWatchStatus.svelte';
import { ensureSignerReady } from '$lib/services/signerReadiness.svelte';
import { errorMessage, normalizePubKey } from '$lib/utils';

/**
 * Level-triggered watch reconciler.
 *
 * Desired state: every watchable group has a live subscription on a healthy
 * client. Actual state: the `currentWatches` map. Anything that happens —
 * stream death, foreground return, account switch, a group being added — is
 * just a trigger for `requestTick()`; each tick re-derives the diff between
 * desired and actual and converges:
 *
 *   1. Reap   — teardown watches whose setup exceeded its deadline or whose
 *               stream went stale past the keepalive window; those coordinators
 *               get a fresh client identity.
 *   2. Diff   — open subscriptions for watchable groups that lack one,
 *               respecting per-coordinator backoff after failed starts.
 *   3. Catch-up — re-fetch backlogs for already-watched groups (closes gaps
 *               from backgrounding); a coordinator whose stream missed messages
 *               it should have delivered is proven a zombie and rebuilt.
 *
 * Convergence rests on cursor idempotency: ingestion dedups by cursor, so
 * "tear everything down and restart from cursors" is always safe. Teardown is
 * therefore instant and local — abort publishes are fire-and-forget hints,
 * never something correctness depends on. Every await is bounded, and
 * recovery is local: a failed step swaps its client and backs off, and the
 * next trigger re-ensures — there is no global escalation.
 */

export const chatGroupWatchStore = $state<{
	startup: 'idle' | 'starting' | 'ready' | 'error';
	error: string;
}>({
	startup: 'idle',
	error: ''
});

type GroupWatchTask = {
	groupIds: string[];
	coordinatorKey: string;
	startedAt: number;
	/** The client this watch's calls run on — used to ignore stale-client collateral. */
	client?: coordinatorClient;
	/** Live once the subscription is wired; false while backlog/subscribe setup runs. */
	live: boolean;
	closing: boolean;
	/** Best-effort abort publish, available once the subscription exists. */
	abort?: (reason?: string) => Promise<void>;
	ready: Promise<void>;
	task: Promise<void>;
	/** Reads the SDK session's staleness once the subscription is live. */
	isStale?: () => boolean;
	/**
	 * Wall-clock ms of the last delivered *chunk* (not any keepalive frame).
	 * Undefined until the first message arrives. The catch-up phase pairs a
	 * cursor gap with `isDeliveryStale` to prove a keepalive-green zombie —
	 * the one failure mode no timer can catch.
	 */
	lastChunkAt?: number;
};

type WatchableGroup = {
	id: string;
	coordinatorKey: string;
	gid: string;
	after?: number;
};

type WatchIncomingMessage = {
	cursor: number;
	createdAt: number;
	opaqueMessageBase64: string;
};

type WatchFetchedMessage = WatchIncomingMessage & {
	gid: string;
};

type TickOptions = {
	/** Run the catch-up sweep (foreground/online/heartbeat triggers). */
	catchUp?: boolean;
};

/**
 * Per-watch deadline for backlog fetch + subscribe setup to settle. Must
 * exceed the legitimate worst case (20s backlog + 20s subscribe), or a
 * concurrent tick reaps healthy setups mid-flight.
 */
const WATCH_SETUP_DEADLINE_MS = 45_000;
/**
 * Backlog fetch (msg_fetch_many) timeout. Idempotent cursor read; matches the
 * pre-reconciler value — real-relay latency needs the headroom, and a failure
 * no longer kills the watch (see startCoordinatorWatches).
 */
const WATCH_BACKLOG_FETCH_TIMEOUT_MS = 20_000;
/** Foreground heartbeat — the convergence backstop for keepalive-green zombies. */
const HEARTBEAT_INTERVAL_MS = 60_000;
/** Min spacing between catch-up sweeps (focus/visibility events can burst). */
const CATCH_UP_MIN_INTERVAL_MS = 5_000;
/** Hides the "Updating chats…" banner for ticks that finish quickly. */
const BANNER_DELAY_MS = 500;
/**
 * Extra slack over the SDK keepalive window (idle + probe) before a
 * still-active subscription is treated as a server-killed zombie. Background
 * tabs throttle keepalive timers so the session never reaches its own abort.
 */
const STALE_STREAM_MARGIN_MS = 10_000;
/** Same window measured from the last delivered chunk (zombie proof, see above). */
const DELIVERY_STALE_MS = 30_000 + 20_000 + STALE_STREAM_MARGIN_MS;
/** Reconnect backoff per coordinator after a failed watch start. */
const COORDINATOR_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000];
const WATCH_INGEST_BATCH_SIZE = 50;
const WATCH_INGEST_FLUSH_MS = 0;

const currentWatches = new Map<string, GroupWatchTask>();
const groupIdDecoder = new TextDecoder();
const coordinatorBackoff = new Map<string, { failures: number; notBefore: number }>();

let tickPromise: Promise<void> | null = null;
let tickDirty = false;
let dirtyCatchUp = false;
let lastCatchUpAt = 0;
/** True while a detached catch-up sweep is running (see tickBody). */
let catchUpInFlight = false;
let lastActiveAccountId = '';
/** Armed once the first tick settled, so fresh opens start silently. */
let warmed = false;

function getCurrentWatch(groupId: string) {
	return currentWatches.get(groupId);
}

function findWatchHandleByCoordinator(coordinatorKey: string): GroupWatchTask | undefined {
	for (const handle of currentWatches.values()) {
		if (handle.coordinatorKey === coordinatorKey) return handle;
	}
	return undefined;
}

/** True when the stream hasn't delivered a chunk within the keepalive window.
 *
 * A watch that has never delivered a chunk gets its grace from `startedAt`
 * instead: young/quiet watches must not read as zombies just because a
 * catch-up fetch found messages first (the natural fetch-vs-stream race). */
function isDeliveryStale(handle: GroupWatchTask): boolean {
	const since = handle.lastChunkAt ?? handle.startedAt;
	return Date.now() - since > DELIVERY_STALE_MS;
}

function clearCurrentWatch(handle?: GroupWatchTask | null) {
	if (!handle) {
		currentWatches.clear();
		markAllGroupsUnwatched();
		return;
	}

	for (const groupId of handle.groupIds) {
		if (currentWatches.get(groupId) === handle) {
			currentWatches.delete(groupId);
			markGroupUnwatched(groupId);
		}
	}
}

/**
 * Teardown is always local and instant: mark closing, unregister, fire the
 * abort publish in the background. Correctness never depends on the publish
 * landing — the coordinator's TTL reaps idle streams, and rebuilds switch to a
 * fresh identity anyway.
 */
function closeWatch(handle: GroupWatchTask, reason: string) {
	handle.closing = true;
	clearCurrentWatch(handle);
	if (handle.abort) void handle.abort(reason).catch(() => undefined);
	void handle.task.catch(() => undefined);
	void handle.ready.catch(() => undefined);
}

function stopCoordinatorWatches(coordinatorKey: string, reason: string) {
	for (const handle of new Set(currentWatches.values())) {
		if (handle.coordinatorKey === coordinatorKey) closeWatch(handle, reason);
	}
}

export function stopWatchingGroup(groupId?: string, reason = 'group stopped'): Promise<void> {
	if (!groupId) {
		for (const handle of new Set(currentWatches.values())) {
			closeWatch(handle, reason);
		}
		return Promise.resolve();
	}

	const watch = currentWatches.get(groupId) ?? null;
	clearCurrentWatch(watch);
	if (watch) closeWatch(watch, reason);
	return Promise.resolve();
}

function backoffBlocks(coordinatorKey: string): boolean {
	const entry = coordinatorBackoff.get(coordinatorKey);
	return Boolean(entry && Date.now() < entry.notBefore);
}

function recordCoordinatorFailure(coordinatorKey: string) {
	const entry = coordinatorBackoff.get(coordinatorKey) ?? { failures: 0, notBefore: 0 };
	entry.failures += 1;
	const delay =
		COORDINATOR_BACKOFF_MS[Math.min(entry.failures - 1, COORDINATOR_BACKOFF_MS.length - 1)] ??
		COORDINATOR_BACKOFF_MS[COORDINATOR_BACKOFF_MS.length - 1];
	entry.notBefore = Date.now() + delay;
	coordinatorBackoff.set(coordinatorKey, entry);
}

function clearCoordinatorBackoff(coordinatorKey: string) {
	coordinatorBackoff.delete(coordinatorKey);
}

function clearAllCoordinatorBackoff() {
	coordinatorBackoff.clear();
}

function toWatchableGroup(groupId: string): WatchableGroup | null {
	const group = getChatGroup(groupId);
	if (!group || isChatGroupRemoved(group) || isChatGroupPoisoned(group)) {
		return null;
	}

	const state = decodeStoredGroupState(group);
	const hasCursor = group.fetchCursor > 0;
	const gid = groupIdDecoder.decode(state.groupContext.groupId);
	const watchable: WatchableGroup = {
		id: group.id,
		coordinatorKey: group.coordinatorKey,
		gid
	};

	if (hasCursor) {
		watchable.after = group.fetchCursor;
	}

	return watchable;
}

function getWatchableGroups(input: { includeCurrentWatches: boolean }) {
	return listChatGroups()
		.filter((group) => input.includeCurrentWatches || getCurrentWatch(group.id) === undefined)
		.map((group) => toWatchableGroup(group.id))
		.filter((group): group is WatchableGroup => Boolean(group));
}

function groupWatchableGroupsByCoordinator(groups: WatchableGroup[]) {
	const groupsByCoordinator = new Map<string, WatchableGroup[]>();

	for (const group of groups) {
		const coordinatorGroups = groupsByCoordinator.get(group.coordinatorKey) ?? [];
		coordinatorGroups.push(group);
		groupsByCoordinator.set(group.coordinatorKey, coordinatorGroups);
	}

	return groupsByCoordinator;
}

function createWatchBuffer(input: {
	groupId: string;
	isClosing: () => boolean;
	abort: (reason?: string) => void;
}) {
	const pendingMessages: WatchIncomingMessage[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let flushPromise = Promise.resolve(false);

	const reportFlushError = (error: unknown) => {
		if (input.isClosing()) {
			return;
		}
		const detail = errorMessage(error);
		console.warn('[watch] failed to ingest watched group messages', {
			groupId: input.groupId,
			detail
		});
	};

	const clearFlushTimer = () => {
		if (!flushTimer) return;
		clearTimeout(flushTimer);
		flushTimer = undefined;
	};

	const flush = () => {
		flushPromise = flushPromise
			.catch((error) => {
				reportFlushError(error);
				return false;
			})
			.then(async () => {
				clearFlushTimer();
				if (pendingMessages.length === 0) return false;

				const batch = pendingMessages.splice(0, pendingMessages.length);
				const result = await ingestIncomingChatGroupMessages(input.groupId, batch);
				if (isChatGroupRemoved(result.group) || isChatGroupPoisoned(result.group)) {
					input.abort(isChatGroupRemoved(result.group) ? 'removed from group' : 'group poisoned');
					return true;
				}

				// Keep the worker's nativeCursor in lockstep with what the live path
				// just ingested, so it never re-notifies these messages as a count.
				// No-op off-native; MAX-clamped on the native side.
				if (isNativePlatform()) {
					void advanceNativeCursor(input.groupId, groupFetchWatermark(result.group));
				}

				return false;
			})
			.catch((error) => {
				reportFlushError(error);
				return false;
			});
		return flushPromise;
	};

	return {
		push(message: WatchIncomingMessage) {
			pendingMessages.push(message);
			if (pendingMessages.length >= WATCH_INGEST_BATCH_SIZE) {
				return flush();
			}

			if (!flushTimer) {
				flushTimer = setTimeout(() => {
					flushTimer = undefined;
					void flush().catch(reportFlushError);
				}, WATCH_INGEST_FLUSH_MS);
			}

			return Promise.resolve(false);
		},
		flush,
		clearFlushTimer
	};
}

async function ingestGroupMessagesFromCoordinatorFetch(
	groupsByGid: Map<string, WatchableGroup>,
	messages: WatchFetchedMessage[]
): Promise<Set<string>> {
	const messagesByGroupId = new Map<string, WatchIncomingMessage[]>();
	const failedGroupIds = new Set<string>();

	for (const message of messages) {
		const group = groupsByGid.get(message.gid);
		if (!group) continue;
		const groupMessages = messagesByGroupId.get(group.id) ?? [];
		groupMessages.push({
			cursor: message.cursor,
			createdAt: message.createdAt,
			opaqueMessageBase64: message.opaqueMessageBase64
		});
		messagesByGroupId.set(group.id, groupMessages);
	}

	for (const [groupId, groupMessages] of messagesByGroupId) {
		try {
			const result = await ingestIncomingChatGroupMessages(groupId, groupMessages);
			if (isChatGroupPoisoned(result.group)) {
				failedGroupIds.add(groupId);
			}
			if (isNativePlatform()) {
				void advanceNativeCursor(groupId, groupFetchWatermark(result.group));
			}
		} catch (error) {
			const detail = errorMessage(error);
			console.warn('[watch] failed to ingest coordinator backlog for group', {
				groupId,
				messageCount: groupMessages.length,
				detail
			});
			failedGroupIds.add(groupId);
		}
	}

	return failedGroupIds;
}

async function fetchCoordinatorGroupBacklog(input: {
	client: coordinatorClient;
	groups: WatchableGroup[];
}): Promise<{ failedGroupIds: Set<string>; ingestedCount: number }> {
	const groupsByGid = new Map(input.groups.map((group) => [group.gid, group]));
	const result = await input.client.FetchManyGroupMessages(
		{
			groups: input.groups.map((group) => ({
				gid: group.gid,
				after: group.after
			}))
		},
		{ timeout: WATCH_BACKLOG_FETCH_TIMEOUT_MS }
	);
	if (result.messages.length === 0) return { failedGroupIds: new Set(), ingestedCount: 0 };

	const failedGroupIds = await ingestGroupMessagesFromCoordinatorFetch(
		groupsByGid,
		result.messages.map((message) => ({
			gid: message.gid,
			cursor: message.cursor,
			createdAt: message.at,
			opaqueMessageBase64: message.msg_64
		}))
	);
	return { failedGroupIds, ingestedCount: result.messages.length };
}

/**
 * Record an unexpected subscription termination. Transient failures mark the
 * coordinator degraded and swap in a fresh client identity — the dead stream's
 * ephemeral key may hold zombie server state on pre-.10 coordinators, which
 * would poison the resubscribe. The stream loop's finally block schedules the
 * restart tick.
 */
function noteStreamFailure(
	coordinatorKey: string,
	client: coordinatorClient,
	error: unknown,
	what: string
) {
	const detail = errorMessage(error);
	// Failures observed on an already-retired client are teardown collateral
	// from an earlier swap: not evidence, so no degraded mark, no new swap.
	if (!isCurrentCoordinatorClient(coordinatorKey, client)) {
		console.debug('[watch] stream failure on retired client — ignored', {
			coordinatorKey,
			what,
			detail
		});
		return;
	}
	if (isTransientCoordinatorError(error)) {
		// First-domino visibility: the swap itself is silent by design, but the
		// original transient error should be findable when debugging.
		console.debug('[watch] transient stream failure — swapping client', {
			coordinatorKey,
			what,
			detail
		});
		markCoordinatorDegraded(coordinatorKey, detail);
		const account = manager.getActive();
		if (account) replaceCoordinatorClient(coordinatorKey, account, client);
	} else {
		console.warn(`[watch] ${what}`, { coordinatorKey, detail });
	}
}

async function startCoordinatorWatches(
	account: IAccount,
	coordinatorKey: string,
	groups: WatchableGroup[]
): Promise<void> {
	const groupIds = groups.map((group) => group.id);
	const handle: GroupWatchTask = {
		groupIds,
		coordinatorKey,
		startedAt: Date.now(),
		live: false,
		closing: false,
		ready: Promise.resolve(),
		task: Promise.resolve()
	};

	// Register synchronously, before any await, so the tick's diff sees these
	// groups as covered while the backlog fetch is in flight.
	for (const groupId of groupIds) {
		currentWatches.set(groupId, handle);
		markGroupWatched(groupId);
	}

	const readyPromise = (async () => {
		try {
			// Backlog first: bring the local cursor up to the server tip before
			// the stream opens (the stream only delivers what arrives after
			// `after`). A backlog failure is NOT fatal to the watch — cursor
			// idempotency lets the catch-up phase close the gap later, and a slow
			// fetch must not cost the group its live subscription.
			const client = getCoordinatorClient(account, coordinatorKey);
			handle.client = client;
			let failedGroupIds = new Set<string>();
			try {
				({ failedGroupIds } = await fetchCoordinatorGroupBacklog({ client, groups }));
			} catch (error) {
				console.warn('[watch] backlog fetch failed — subscribing anyway', {
					coordinatorKey,
					detail: errorMessage(error)
				});
			}
			if (handle.closing) return;
			const subscriptionGroups = groupIds
				.filter((groupId) => !failedGroupIds.has(groupId))
				.map((groupId) => toWatchableGroup(groupId))
				.filter((group): group is WatchableGroup => Boolean(group));
			if (subscriptionGroups.length === 0) {
				clearCurrentWatch(handle);
				return;
			}
			// Setup is deadline-bounded inside the client: a wedged socket rejects
			// as a transient error instead of hanging the watch forever.
			const subscription = await client.SubscribeManyGroupMessages({
				groups: subscriptionGroups.map((group) => ({
					gid: group.gid,
					after: group.after
				}))
			});
			if (handle.closing) {
				void subscription.abort('teardown during setup').catch(() => undefined);
				clearCurrentWatch(handle);
				return;
			}
			handle.live = true;

			const groupsByGid = new Map(subscriptionGroups.map((group) => [group.gid, group]));
			const buffers = new Map(
				subscriptionGroups.map((group) => [
					group.id,
					createWatchBuffer({
						groupId: group.id,
						isClosing: () => handle.closing,
						abort: (reason?: string) => void handle.abort?.(reason)
					})
				])
			);

			handle.abort = (reason?: string) => subscription.abort(reason);
			handle.isStale = () => subscription.isStale(STALE_STREAM_MARGIN_MS);

			handle.task = (async () => {
				void subscription.result.catch((error) => {
					if (handle.closing) return;
					noteStreamFailure(
						coordinatorKey,
						client,
						error,
						'coordinator subscription result failed'
					);
				});

				try {
					for await (const message of subscription.stream) {
						const group = groupsByGid.get(message.gid);
						const buffer = group ? buffers.get(group.id) : undefined;
						if (!buffer) continue;
						handle.lastChunkAt = Date.now();

						if (
							await buffer.push({
								cursor: message.cursor,
								createdAt: message.at,
								opaqueMessageBase64: message.msg_64
							})
						) {
							return;
						}
					}
				} catch (error) {
					if (!handle.closing) {
						noteStreamFailure(
							coordinatorKey,
							client,
							error,
							'coordinator subscription stream failed'
						);
					}
				} finally {
					await Promise.all(
						[...buffers.values()].map((buffer) => buffer.flush().catch(() => false))
					);
					for (const buffer of buffers.values()) {
						buffer.clearFlushTimer();
					}
					clearCurrentWatch(handle);
					// A clean server close (or unexpected death) leaves these groups
					// unwatched; the next tick's diff restarts them. `closing` means
					// we tore the watch down ourselves.
					if (!handle.closing) requestTick('subscription ended');
				}
			})();
			void handle.task.catch(() => undefined);
		} catch (error) {
			// Backlog fetch or subscribe threw. If torn down mid-start, resolve
			// cleanly — the background client teardown interrupts in-flight calls
			// and the diff will re-open the watch on the next tick.
			clearCurrentWatch(handle);
			if (handle.closing) return;
			// Same for a retired client: the failure is collateral from an earlier
			// swap — record nothing, swap nothing, warn nothing; the next tick's
			// diff re-opens the watch on the replacement client.
			if (handle.client && !isCurrentCoordinatorClient(coordinatorKey, handle.client)) return;
			throw error;
		}
	})();

	handle.ready = readyPromise;
	// Standing catch: this promise is fire-and-forget at the call site, so a
	// late rejection must never surface as unhandled.
	readyPromise.catch(() => undefined);
	return readyPromise;
}

/** Phase 1: teardown watches that are provably dead, rebuild their clients. */
function reapUnhealthyWatches(account: IAccount) {
	const reapedCoordinators = new Set<string>();
	for (const handle of new Set(currentWatches.values())) {
		if (handle.closing) continue;
		if (!handle.live) {
			if (Date.now() - handle.startedAt <= WATCH_SETUP_DEADLINE_MS) continue;
			console.warn('[watch] setup exceeded deadline — reaping watch', {
				coordinatorKey: handle.coordinatorKey,
				ms: WATCH_SETUP_DEADLINE_MS
			});
		} else if (!handle.isStale?.()) {
			continue;
		} else {
			console.warn('[watch] stream stale past keepalive window — reaping watch', {
				coordinatorKey: handle.coordinatorKey
			});
		}
		closeWatch(handle, 'watch reaped');
		reapedCoordinators.add(handle.coordinatorKey);
	}
	// Fresh identity for reaped coordinators: the socket is suspect, and a
	// pre-.10 server may hold zombie state for the old ephemeral key.
	for (const coordinatorKey of reapedCoordinators) {
		replaceCoordinatorClient(coordinatorKey, account);
	}
	return reapedCoordinators;
}

/** Phase 2: open subscriptions for watchable groups that lack one. */
async function startMissingWatches(account: IAccount) {
	const desired = getWatchableGroups({ includeCurrentWatches: false });
	if (desired.length === 0) return;

	const groupsByCoordinator = groupWatchableGroupsByCoordinator(desired);
	await Promise.all(
		[...groupsByCoordinator.entries()].map(([coordinatorKey, groups]) => {
			if (backoffBlocks(coordinatorKey)) return Promise.resolve();
			// Fire-and-forget: each start is bounded by the client's own setup
			// deadline, stragglers are reaped, and backoff spaces retries.
			// Awaiting full setups here would let one slow coordinator pin the
			// whole tick. Synchronous registration keeps the diff idempotent
			// while setups are in flight.
			void startCoordinatorWatches(account, coordinatorKey, groups)
				.then(() => clearCoordinatorBackoff(coordinatorKey))
				.catch((error) => {
					recordCoordinatorFailure(coordinatorKey);
					// A failed start often means the client itself is dead — a connect
					// timeout leaves the rejected connect promise cached on the client
					// forever, and a closed transport rejects every call. Swap a fresh
					// identity so the backoff-spaced retry isn't pounding a corpse.
					if (isTransientCoordinatorError(error)) {
						replaceCoordinatorClient(coordinatorKey, account);
					}
					console.warn('[watch] failed to start coordinator watches', {
						coordinatorKey,
						detail: errorMessage(error)
					});
				});
			return Promise.resolve();
		})
	);
}

/**
 * Phase 3: close delivery gaps for groups that already had a live subscription
 * during a likely connectivity gap, and prove keepalive-green zombies. Nostr
 * does not redeliver what the server pushed while the client was
 * backgrounded/disconnected, and suspended JS timers can hide that gap from
 * the CEP-41 keepalive — so after reconnecting we re-fetch from each group's
 * cursor (idempotent via cursor dedup).
 *
 * A coordinator whose catch-up found messages its own live stream should have
 * delivered, while that stream was chunk-silent past the keepalive window, is
 * proven a zombie: tear it down, swap the identity, and let the loop restart
 * it. The chunk-silence guard avoids false positives from the natural race
 * where a message lands between live delivery and the catch-up fetch.
 */
async function catchUpWatchedCoordinators(account: IAccount, watchedBefore: string[]) {
	if (watchedBefore.length === 0) return;

	const groupsByCoordinator = new Map<string, WatchableGroup[]>();
	for (const groupId of watchedBefore) {
		const watchable = toWatchableGroup(groupId);
		if (!watchable) continue;
		const list = groupsByCoordinator.get(watchable.coordinatorKey) ?? [];
		list.push(watchable);
		groupsByCoordinator.set(watchable.coordinatorKey, list);
	}

	await Promise.all(
		[...groupsByCoordinator.entries()].map(async ([coordinatorKey, groups]) => {
			const client = getCoordinatorClient(account, coordinatorKey);
			const { ingestedCount } = await fetchCoordinatorGroupBacklog({
				client,
				groups
			}).catch((error) => {
				console.warn('[watch] catch-up fetch failed', {
					coordinatorKey,
					detail: errorMessage(error)
				});
				return { failedGroupIds: new Set<string>(), ingestedCount: 0 };
			});
			if (ingestedCount === 0) return;
			const handle = findWatchHandleByCoordinator(coordinatorKey);
			if (handle && !isDeliveryStale(handle)) return;

			stopCoordinatorWatches(coordinatorKey, 'delivery gap detected');
			replaceCoordinatorClient(coordinatorKey, account, client);
			requestTick('zombie coordinator detected');
		})
	);
}

async function tickBody(account: IAccount, options: TickOptions): Promise<void> {
	// Identity gate: NIP-07 extension signers race app startup; waiting here
	// keeps "signer extension missing" from ever reaching coordinator calls.
	await ensureSignerReady(account);
	// §10.6: reconcile the MD tip before delivery streams open. Idempotent,
	// session-cached, and bounded; a no-op when multi-device is off.
	await awaitMultiDeviceReconciled();

	const watchedBefore = [...currentWatches.keys()];

	reapUnhealthyWatches(account);

	// Both convergence phases run DETACHED from the tick. Every step inside
	// them is individually bounded (fetch timeouts, setup deadlines,
	// per-coordinator backoff) and idempotent (cursor dedup), so awaiting them
	// here bought nothing — an awaited catch-up (20s fetch + unbounded
	// ingestion) regularly overran any global ceiling. Recovery is purely
	// LOCAL: each failure path swaps the client and applies backoff, and the
	// next trigger re-ensures. (A global tick deadline + hard-reset hammer was
	// removed: with all real work detached it measured nothing real, yet its
	// teardown destroyed healthy in-flight connections and bred the very
	// retry storm it blamed.) A catch-up request while a sweep is still
	// running is skipped: live subscriptions cover the interim, and the next
	// trigger re-runs it.
	await startMissingWatches(account);
	if (options.catchUp && !catchUpInFlight) {
		catchUpInFlight = true;
		void catchUpWatchedCoordinators(account, watchedBefore)
			.catch(() => undefined)
			.finally(() => {
				catchUpInFlight = false;
			});
	}
}

async function runTick(reason: string, options: TickOptions): Promise<void> {
	const account = manager.getActive();
	if (!account) {
		return;
	}

	chatGroupWatchStore.startup = 'starting';
	chatGroupWatchStore.error = '';

	// The banner and the send-blocking resume mirror are for connectivity
	// RECOVERY only (catch-up sweeps, account switch) — never for steady-state
	// ensure ticks: the layout $effect fires one per ingested message, and a
	// banner (or a send blocked behind the mirror) on every message is exactly
	// the old choreography bug in new clothes. Fresh opens stay silent too.
	const recovery = options.catchUp === true || reason === 'active account changed';
	const showBanner = warmed && recovery;
	let bannerTimer: ReturnType<typeof setTimeout> | undefined;
	if (showBanner) {
		bannerTimer = setTimeout(() => setChatReconnectStatus('Updating chats…'), BANNER_DELAY_MS);
	}
	const clearBannerTimer = () => {
		if (bannerTimer) {
			clearTimeout(bannerTimer);
			bannerTimer = undefined;
		}
	};

	try {
		// No global deadline: the tick awaits only the bounded gates in
		// tickBody, and every detached phase owns its recovery (client swap +
		// backoff + the next trigger's re-ensure).
		await tickBody(account, options);
		chatGroupWatchStore.startup = 'ready';
		clearBannerTimer();
		clearChatReconnectStatus();
	} catch (error) {
		chatGroupWatchStore.startup = 'error';
		chatGroupWatchStore.error = error instanceof Error ? error.message : 'Failed to update chats';
		clearBannerTimer();
		if (showBanner) {
			failChatReconnectStatus(chatGroupWatchStore.error);
		}
	} finally {
		// Arm lifecycle triggers after the first tick settles, including on
		// error, so a failed initial start can still be retried by foreground.
		warmed = true;
	}
}

/**
 * Single entry point for every trigger. Coalesces: a request while a tick is
 * in flight marks it dirty and merges into the follow-up that runs once the
 * current tick settles — bursts of triggers cost at most two ticks.
 */
function requestTick(reason: string, options: TickOptions = {}): Promise<void> {
	let catchUp = options.catchUp === true;
	if (catchUp && Date.now() - lastCatchUpAt < CATCH_UP_MIN_INTERVAL_MS) {
		catchUp = false;
	}

	if (tickPromise) {
		tickDirty = true;
		dirtyCatchUp = dirtyCatchUp || catchUp;
		return tickPromise;
	}

	if (catchUp) lastCatchUpAt = Date.now();

	const promise = runTick(reason, { catchUp });
	tickPromise = promise;
	// Outbound sends await the in-flight tick via this mirror so they never
	// race a teardown/backlog ingestion (chatUiActions) — but only while a
	// recovery tick is actually rebuilding state; steady-state ticks must not
	// block sends.
	const mirrorsResume = catchUp || reason === 'active account changed';
	if (mirrorsResume) setChatGroupResumePromise(promise);
	promise.finally(() => {
		if (tickPromise === promise) {
			tickPromise = null;
			if (mirrorsResume) setChatGroupResumePromise(null);
			if (tickDirty) {
				tickDirty = false;
				const nextCatchUp = dirtyCatchUp;
				dirtyCatchUp = false;
				void requestTick(`${reason} (follow-up)`, { catchUp: nextCatchUp });
			}
		}
	});
	return promise;
}

/**
 * Public "ensure every watchable group is watched" entry point, used by the
 * chat layout effect and the account-change handler. Same machinery as every
 * other trigger: schedule a tick.
 */
export function startWatchingAllGroups(): Promise<void> {
	return requestTick('ensure watches');
}

/**
 * Manual refresh (pull-to-refresh): one catch-up pass over all watched groups,
 * same machinery as the focus/online triggers. Re-entrant and coalesced; subject
 * to the catch-up rate limit, so a pull right after a focus pass is a cheap no-op
 * tick rather than a redundant backlog fan-out.
 */
export function refreshWatchedGroups(): Promise<void> {
	return requestTick('pull-to-refresh', { catchUp: true });
}

if (browser) {
	manager.active$.subscribe((account) => {
		const nextAccountId = account?.id ?? '';
		if (nextAccountId === lastActiveAccountId) {
			return;
		}

		const previousAccount = manager.getAccount(lastActiveAccountId);
		lastActiveAccountId = nextAccountId;
		chatGroupWatchStore.startup = 'idle';
		const nextOwnerPubkey = account ? normalizePubKey(account.pubkey) : undefined;
		const groupLoadPromise = reloadChatGroupsForOwner(nextOwnerPubkey);
		loadChatGroupPresenceForOwner(nextOwnerPubkey);
		loadWelcomeNotificationsForOwner(nextOwnerPubkey);
		loadJoinRequestsForOwner(nextOwnerPubkey);
		clearAllCoordinatorBackoff();

		void stopWatchingGroup(undefined, 'active account changed').then(async () => {
			await groupLoadPromise;
			pruneChatGroupPresence();
			// Multi-device tip subscription follows the active account: reset the
			// previous owner's reconcile promise + subscription, then let the
			// tick's §10.6 gate re-reconcile for this owner (no-op when MD is off).
			resetMultiDeviceSession();
			if (account) {
				void requestTick('active account changed');
			}
		});
		if (previousAccount) {
			queryClient.removeQueries({ queryKey: chatQueryKeys.account(previousAccount.pubkey) });
			void disconnectCoordinatorClients(previousAccount);
		}
	});

	// Foreground recovery: a backgrounded/throttled tab can leave a
	// server-killed stream as a locally-active zombie, so on return to
	// foreground the tick reaps stale streams and closes delivery gaps.
	window.addEventListener('online', () => {
		clearAllCoordinatorBackoff();
		requestTick('browser online', { catchUp: true });
	});
	window.addEventListener('pageshow', () => requestTick('page show', { catchUp: true }));
	window.addEventListener('focus', () => requestTick('window focus', { catchUp: true }));
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') requestTick('page visible', { catchUp: true });
	});

	// Convergence heartbeat: the catch-up sweep is the only signal that can
	// prove a keepalive-green zombie (server pings flow, chunks don't), so run
	// it on a slow foreground-only cadence. Background sweeps are skipped
	// (throttled timers + battery); the next foreground closes that gap.
	setInterval(() => {
		if (document.visibilityState !== 'visible' || !warmed) return;
		requestTick('heartbeat', { catchUp: true });
	}, HEARTBEAT_INTERVAL_MS);
}
