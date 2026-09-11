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
	isCoordinatorSignerActive,
	isTransientCoordinatorError,
	rebuildAllCoordinatorClients,
	replaceCoordinatorClient
} from '$lib/services/chatRuntime';
import { focusManager } from '@tanstack/svelte-query';
import { App } from '@capacitor/app';
import type { IAccount } from 'applesauce-accounts';
import type { coordinatorClient } from '$lib/services/coordinatorClient';
import {
	clearChatReconnectStatus,
	failChatReconnectStatus,
	setChatReconnectStatus
} from '$lib/services/chatReconnectStatus.svelte';
import {
	getCoordinatorHealthTone,
	markCoordinatorDegraded
} from '$lib/services/coordinatorHealth.svelte';
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
	markGroupFeedLive,
	markGroupsBacklogComplete,
	markGroupsBacklogIncomplete,
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
 *   1. Reap   — teardown watches whose setup exceeded its deadline; those
 *               coordinators get a fresh client identity.
 *   2. Diff   — open subscriptions for watchable groups that lack one,
 *               respecting per-coordinator backoff after failed starts.
 *   3. Catch-up — re-fetch backlogs for already-watched groups (closes gaps
 *               from backgrounding); a coordinator whose stream missed messages
 *               it should have delivered is proven a zombie and rebuilt.
 *
 * Suspension recovery is NOT detect-and-reap: after a phone background / tab
 * freeze / OS sleep the process was frozen, so every in-page staleness signal
 * was frozen with it. `rebuildForeground()` handles that class instead —
 * assume dead, tear down locally, swap fresh clients, converge from cursors.
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
	/** Live only once the server's stream-start frame has arrived. */
	live: boolean;
	closing: boolean;
	/** Best-effort abort publish, available once the subscription exists. */
	abort?: (reason?: string) => Promise<void>;
	ready: Promise<boolean>;
	task: Promise<void>;
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
/** A beat older than this means timers stopped while nothing else could tell — suspension. */
const HEARTBEAT_MISSED_MS = HEARTBEAT_INTERVAL_MS + 30_000;
/** Min spacing between catch-up sweeps (focus/visibility events can burst). */
const CATCH_UP_MIN_INTERVAL_MS = 5_000;
/** Hides the "Updating chats…" banner for ticks that finish quickly. */
const BANNER_DELAY_MS = 500;
/**
 * Extra slack added to the chunk-silence window (`DELIVERY_STALE_MS`) before a
 * delivery gap counts as zombie proof — headroom for a legitimately quiet
 * stream plus clock skew, so the catch-up phase doesn't rebuild healthy
 * coordinators on the natural fetch-vs-stream race in busy groups.
 */
const STALE_STREAM_MARGIN_MS = 10_000;
/** Same window measured from the last delivered chunk (zombie proof, see above). */
const DELIVERY_STALE_MS = 30_000 + 20_000 + STALE_STREAM_MARGIN_MS;
/**
 * Reconnect backoff per coordinator after a failed watch start. Unbounded-
 * ish ladder capped at 5min: a hard-down coordinator gets ~1 bounded probe
 * cycle per 5min instead of a fresh dial every 15s, while recovery latency
 * stays instant — any successful RPC marks the coordinator healthy and
 * `backoffBlocks` immediately un-blocks the next watch retry.
 */
const COORDINATOR_BACKOFF_MS = [
	1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000
];
/** Min spacing between foreground rebuilds (resume fires several events). */
const REBUILD_DEBOUNCE_MS = 5_000;
const WATCH_INGEST_BATCH_SIZE = 50;
/** Live-stream flush window. 0 flushed every message individually (a full
 * ingest cycle + persist + reactive invalidation per message); a short window
 * coalesces a burst into one cycle at ≤40ms delivery latency. Bursts beyond
 * the batch size still flush immediately. */
const WATCH_INGEST_FLUSH_MS = 40;

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

function clearCurrentWatch(handle: GroupWatchTask) {
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

	const watch = currentWatches.get(groupId);
	if (watch) closeWatch(watch, reason);
	return Promise.resolve();
}

let hiddenAt: number | null = null;
let wasFrozen = false;
let signerRoundTrip = false;
let lastRebuildAt = 0;
let lastHeartbeatAt = Date.now();

function noteBackground(): void {
	hiddenAt ??= Date.now();
	// Latch at departure: the signer result can arrive before the resume event.
	signerRoundTrip ||= isNativePlatform() && isCoordinatorSignerActive();
}

function resumeForeground(reason: string): void {
	// Suspension evidence, strongest first: an explicit freeze/bfcache event, or
	// heartbeat silence past its tolerance — timers that stayed quiet while hidden
	// mean the process was frozen or the OS slept, so every socket is suspect.
	// Elapsed hidden time alone is NOT evidence: a hidden-but-alive desktop tab
	// keeps firing the heartbeat and delivering on its sockets, and rebuilding on
	// return was discarding exactly those healthy connections.
	const heartbeatMissed = Date.now() - lastHeartbeatAt > HEARTBEAT_MISSED_MS;
	const rebuild = wasFrozen || heartbeatMissed || (isNativePlatform() && hiddenAt !== null);
	const returningFromSigner = signerRoundTrip;
	// A handled departure must not be detected again by the next heartbeat.
	lastHeartbeatAt = Date.now();
	hiddenAt = null;
	wasFrozen = false;
	signerRoundTrip = false;
	if (rebuild && !returningFromSigner) rebuildForeground(reason);
	else void requestTick(reason, { catchUp: true });
}

/**
 * Post-suspension recovery. After a phone background / tab freeze / OS sleep
 * every stream and socket is dead by assumption — frozen JS cannot keep
 * keepalives alive, and liveness detection from inside the suspended process
 * is unreliable. So instead of forensics: close all watches locally (instant;
 * aborts are fire-and-forget hints), swap every existing client for a fresh
 * identity so reconnects start at resume time (not after the user's first
 * send times out), and let the catch-up tick close delivery gaps from
 * cursors — which are idempotent, so this is always safe.
 */
function rebuildForeground(reason: string): void {
	const account = manager.getActive();
	if (!account) return;
	if (Date.now() - lastRebuildAt < REBUILD_DEBOUNCE_MS) {
		// Debounce-skipped rebuild still owes its lifecycle tick (coalesced,
		// rate-limited): a rapid background→foreground pair must not leave the
		// app unwatched for want of a catch-up.
		void requestTick(reason, { catchUp: true });
		return;
	}
	lastRebuildAt = Date.now();
	hiddenAt = null;
	wasFrozen = false;
	clearAllCoordinatorBackoff();
	void stopWatchingGroup(undefined, 'foreground rebuild');
	rebuildAllCoordinatorClients(account);
	void requestTick(reason, { catchUp: true });
}

function backoffBlocks(coordinatorKey: string): boolean {
	const entry = coordinatorBackoff.get(coordinatorKey);
	if (!entry || Date.now() >= entry.notBefore) return false;
	// The outage is over: any successful coordinator call marked it healthy,
	// so retry the watch immediately instead of idling out the long-cap
	// ladder. Passive probe cadence remains bounded by the schedule above.
	if (getCoordinatorHealthTone(coordinatorKey) === 'healthy') return false;
	return true;
}

function recordCoordinatorFailure(coordinatorKey: string) {
	// Hidden-tab stream aborts are our own timer throttling, not coordinator
	// evidence: after 5min hidden Chrome wakes chained timers at most once a
	// minute, so the 30/30 keepalive starves and aborts healthy streams.
	// Recording those arms the ladder while nothing can clear it (interval
	// polls pause while hidden), spacing hidden restarts out to 5min and
	// stopping message delivery until focus. While hidden, restarts stay
	// prompt — Chrome's own 1-wake/min throttling bounds the dead-coordinator
	// probe rate, and the ladder re-engages on the first visible failure.
	if (browser && document.visibilityState !== 'visible') return;
	const entry = coordinatorBackoff.get(coordinatorKey) ?? { failures: 0, notBefore: 0 };
	// A coordinator already marked degraded failed elsewhere too (reads, ack
	// timeout): it is known-down, so climb two ladder steps per recorded
	// failure — the post-reload ramp reaches the 5min cap in ~4 cycles instead
	// of ~9. The healthy override in backoffBlocks still un-blocks instantly.
	entry.failures += getCoordinatorHealthTone(coordinatorKey) === 'degraded' ? 2 : 1;
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
				if (input.isClosing()) {
					pendingMessages.length = 0;
					return false; // the replacement catches up from the persisted cursor
				}
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
	messages: WatchFetchedMessage[],
	account: IAccount
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
		if (manager.getActive()?.id !== account.id) break;
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
	account: IAccount;
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
	if (
		manager.getActive()?.id !== input.account.id ||
		!isCurrentCoordinatorClient(input.groups[0].coordinatorKey, input.client, input.account)
	) {
		throw new Error('Connection closed during backlog fetch');
	}
	if (result.messages.length === 0) return { failedGroupIds: new Set(), ingestedCount: 0 };

	const failedGroupIds = await ingestGroupMessagesFromCoordinatorFetch(
		groupsByGid,
		result.messages.map((message) => ({
			gid: message.gid,
			cursor: message.cursor,
			createdAt: message.at,
			opaqueMessageBase64: message.msg_64
		})),
		input.account
	);
	return { failedGroupIds, ingestedCount: result.messages.length };
}

/**
 * Record an unexpected subscription termination. A transient failure on the
 * CURRENT client swaps in a fresh identity immediately: the dead stream's
 * ephemeral key may hold zombie server state on pre-.10 coordinators, and a
 * resubscribe on the same key "succeeds" locally (relays accept the publish)
 * while never being acked or delivered — an invisible zombie that only a
 * fresh key avoids. The swap is cheap and bounded by the probe cadence; the
 * stream loop's finally block schedules the restart tick.
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
	// A subscription that died on the CURRENT client is a failed watch: advance
	// the retry ladder so the replacement start is spaced. Cleared again by the
	// next stream start (or any successful call — backoffBlocks' healthy
	// override), so a healthy coordinator's stream blip never idles.
	recordCoordinatorFailure(coordinatorKey);
	if (isTransientCoordinatorError(error)) {
		// First-domino visibility: the swap itself is silent by design, but the
		// original transient error should be findable when debugging.
		markCoordinatorDegraded(coordinatorKey, detail);
		console.debug('[watch] transient stream failure — swapping client', {
			coordinatorKey,
			what,
			detail
		});
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
): Promise<boolean> {
	const groupIds = groups.map((group) => group.id);
	const handle: GroupWatchTask = {
		groupIds,
		coordinatorKey,
		startedAt: Date.now(),
		live: false,
		closing: false,
		ready: Promise.resolve(false),
		task: Promise.resolve()
	};

	// Register synchronously, before any await, so the tick's diff sees these
	// groups as covered while the backlog fetch is in flight.
	for (const groupId of groupIds) {
		currentWatches.set(groupId, handle);
		markGroupWatched(groupId);
	}

	// `true` only when the subscription went live — every failed start
	// (thrown, reap-torn-down, retired-client collateral, nothing to
	// subscribe) resolves or rejects WITHOUT live so the caller keeps the
	// watch-backoff ladder engaged instead of clearing it.
	const readyPromise = (async (): Promise<boolean> => {
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
				({ failedGroupIds } = await fetchCoordinatorGroupBacklog({ account, client, groups }));
				if (handle.closing) return false;
				markGroupsBacklogComplete(groupIds.filter((id) => !failedGroupIds.has(id)));
			} catch (error) {
				if (handle.closing || !isCurrentCoordinatorClient(coordinatorKey, client, account))
					return false;
				console.warn('[watch] backlog fetch failed — subscribing anyway', {
					coordinatorKey,
					detail: errorMessage(error)
				});
				markGroupsBacklogIncomplete(groupIds);
			}
			if (failedGroupIds.size > 0) markGroupsBacklogIncomplete([...failedGroupIds]);
			if (handle.closing) return false;
			const subscriptionGroups = groupIds
				.filter((groupId) => !failedGroupIds.has(groupId))
				.map((groupId) => toWatchableGroup(groupId))
				.filter((group): group is WatchableGroup => Boolean(group));
			if (subscriptionGroups.length === 0) {
				clearCurrentWatch(handle);
				return false;
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
				return false;
			}
			handle.live = true;
			clearCoordinatorBackoff(coordinatorKey);

			const groupsByGid = new Map(subscriptionGroups.map((group) => [group.gid, group]));
			const buffers = new Map(
				subscriptionGroups.map((group) => [
					group.id,
					createWatchBuffer({
						groupId: group.id,
						isClosing: () => handle.closing || manager.getActive()?.id !== account.id,
						abort: (reason?: string) => void handle.abort?.(reason)
					})
				])
			);

			handle.abort = (reason?: string) => subscription.abort(reason);

			handle.task = (async () => {
				// The client routes result failure into the stream, so one failure
				// path below owns recovery (result is not a subscription ack).
				void subscription.result.catch(() => undefined);

				try {
					for await (const message of subscription.stream) {
						if (handle.closing || manager.getActive()?.id !== account.id) break;
						const group = groupsByGid.get(message.gid);
						const buffer = group ? buffers.get(group.id) : undefined;
						if (!group || !buffer) continue;
						handle.lastChunkAt = Date.now();
						markGroupFeedLive(group.id);

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
			return true;
		} catch (error) {
			// Backlog fetch or subscribe threw. If torn down mid-start, resolve
			// cleanly — the background client teardown interrupts in-flight calls
			// and the diff will re-open the watch on the next tick.
			if (handle.closing) return false;
			// Same for a retired client: the failure is collateral from an earlier
			// swap — record nothing, swap nothing, warn nothing; the next tick's
			// diff re-opens the watch on the replacement client.
			if (manager.getActive()?.id !== account.id) return false;
			if (handle.client) {
				noteStreamFailure(
					coordinatorKey,
					handle.client,
					error,
					'failed to start coordinator watch'
				);
			} else {
				recordCoordinatorFailure(coordinatorKey);
				console.warn('[watch] failed to create coordinator client', error);
			}
			return false;
		} finally {
			// Every failed/retired setup must relinquish its watched-status mirror,
			// including early returns from the backlog path.
			if (!handle.live) {
				clearCurrentWatch(handle);
				if (
					!handle.closing &&
					handle.client &&
					manager.getActive()?.id === account.id &&
					!isCurrentCoordinatorClient(coordinatorKey, handle.client, account)
				)
					void requestTick('client replaced during watch setup');
			}
		}
	})();

	handle.ready = readyPromise;
	// Standing catch: this promise is fire-and-forget at the call site, so a
	// late rejection must never surface as unhandled.
	readyPromise.catch(() => undefined);
	return readyPromise;
}

/** Phase 1: teardown watches whose setup provably wedged, rebuild their clients. */
function reapUnhealthyWatches(account: IAccount): void {
	for (const handle of new Set(currentWatches.values())) {
		if (handle.closing || handle.live) continue;
		if (Date.now() - handle.startedAt <= WATCH_SETUP_DEADLINE_MS) continue;
		console.warn('[watch] setup exceeded deadline — reaping watch', {
			coordinatorKey: handle.coordinatorKey,
			ms: WATCH_SETUP_DEADLINE_MS
		});
		closeWatch(handle, 'watch reaped');
		replaceCoordinatorClient(handle.coordinatorKey, account, handle.client);
	}
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
			void startCoordinatorWatches(account, coordinatorKey, groups).catch((error) => {
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
			const { failedGroupIds, ingestedCount } = await fetchCoordinatorGroupBacklog({
				account,
				client,
				groups
			}).catch((error) => {
				console.warn('[watch] catch-up fetch failed', {
					coordinatorKey,
					detail: errorMessage(error)
				});
				// Whole-fetch failure: the backlog is entirely unknown for these
				// groups — conservatively mark them incomplete (never vouch for them
				// on the MD send path) until a fetch succeeds.
				return {
					failedGroupIds: new Set<string>(groups.map((group) => group.id)),
					ingestedCount: 0
				};
			});
			if (
				manager.getActive()?.id !== account.id ||
				!isCurrentCoordinatorClient(coordinatorKey, client, account)
			)
				return;
			markGroupsBacklogComplete(
				groups.filter((group) => !failedGroupIds.has(group.id)).map((group) => group.id)
			);
			markGroupsBacklogIncomplete([...failedGroupIds]);
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
	if (manager.getActive()?.id !== account.id) return;

	// A server start frame establishes readiness; final RPC results do not.
	const watchedBefore = [...currentWatches]
		.filter(([, handle]) => handle.live)
		.map(([groupId]) => groupId);
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
	window.addEventListener('online', () => rebuildForeground('browser online'));
	// bfcache restore: browsers close every WebSocket on bfcache entry, and
	// clock behavior across bfcache is inconsistent — rebuild unconditionally,
	// no oracle.
	window.addEventListener('pageshow', (event) => {
		if (event.persisted) rebuildForeground('restored from back/forward cache');
		else requestTick('page show', { catchUp: true });
	});
	window.addEventListener('focus', () => {
		if (document.visibilityState === 'visible') resumeForeground('window focus');
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') resumeForeground('page visible');
		else noteBackground();
	});
	document.addEventListener('freeze', () => {
		wasFrozen = true;
		noteBackground();
	});
	document.addEventListener('resume', () => {
		wasFrozen = true;
		// Resume can precede visibility; retain the reset until the page is attended.
		if (document.visibilityState === 'visible') resumeForeground('page resumed');
	});
	if (isNativePlatform()) {
		void App.addListener('appStateChange', ({ isActive }) => {
			if (isActive) resumeForeground('native app resumed');
			else noteBackground();
			// Native lifecycle can arrive without a matching DOM visibility event.
			// Never infer online status from focus; browser connectivity still owns it.
			focusManager.setFocused(isActive);
		}).catch(() => undefined);
	}

	// Convergence heartbeat — the universal recovery. Runs REGARDLESS of
	// visibility: a hidden tab's throttled timers still fire on Chrome's
	// ~1-wake/min budget, and the sweep is event-driven (WS RPCs, cursor-dedup
	// idempotent), so it bounds message loss from ANY failure mode — zombie
	// stream, lost ack, aborted restart, blocked ladder — to ~1-2 minutes in
	// background. This is the correctness backstop; every other health
	// mechanism (ladder, swaps, ack gates) is latency optimization on top.
	// ponytail: a killswitch/simplification pass on those layers is the
	// upgrade path if this backstop proves sufficient in practice.
	setInterval(() => {
		const now = Date.now();
		const missedHeartbeat = now - lastHeartbeatAt > HEARTBEAT_MISSED_MS;
		lastHeartbeatAt = now;
		if (!warmed) return;
		// OS sleep can leave a page visible throughout, with no visibility event.
		if (
			missedHeartbeat &&
			document.visibilityState === 'visible' &&
			!signerRoundTrip &&
			!isCoordinatorSignerActive()
		) {
			rebuildForeground('heartbeat after suspension');
		} else {
			requestTick('heartbeat', { catchUp: true });
		}
	}, HEARTBEAT_INTERVAL_MS);
}
