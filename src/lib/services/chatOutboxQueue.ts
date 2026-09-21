import { browser } from '$app/environment';

import { manager } from './accountManager.svelte';
import {
	RemovedFromGroupError,
	ensureGroupsLoaded,
	getChatGroup,
	isChatGroupPoisoned,
	isChatGroupRemoved,
	listChatGroupMessages,
	sendChatGroupMessage
} from './chatGroups.svelte';
import { getChatStorage, type StoredChatOutboxRecord } from '$lib/storage/chatStorage';
import {
	addPendingMessage,
	replaceAllPending,
	removePendingMessage,
	updatePendingMessage
} from './chatOutbox.svelte';
import { getChatGroupResumePromise } from './chatGroupWatchStatus.svelte';
import { ChatKinds } from '$lib/chat/kinds';
import type { ChatMessageReplyTarget } from '$lib/chat/references';
import type { ChatMessage as UiChatMessage } from '$lib/components/chat/chat.types';
import { errorMessage, formatUnixTimestamp, normalizePubKey } from '$lib/utils';

/**
 * Offline outbox — durable queue of plaintext send INTENTS.
 *
 * Text sends persist here BEFORE any network attempt, so they survive reload,
 * app close, and offline spells. The drain re-encrypts each intent against the
 * group's CURRENT MLS state at attempt time (which makes epoch changes while
 * queued a no-op) and posts strictly FIFO per group — MLS generations must stay
 * contiguous per sender, so a blocked head blocks its group's queue.
 *
 * Duplicate safety: msg_post has no server-side dedup, so every attempt
 * persists its event id (via sendChatGroupMessage's onSealed hook) BEFORE the
 * post. An ambiguous outcome (timeout / app closed mid-post) is resolved by a
 * backlog catch-up + event-id check before any retry — confirm-before-retry.
 *
 * Scope: text/reply/mention sends only. Media (upload-first), reactions,
 * edits, deletes, and pins keep their direct fail-fast paths.
 */

const OUTBOX_ID_PREFIX = 'outbox:';
const RETRY_BACKOFF_BASE_MS = 15_000;
const RETRY_BACKOFF_MAX_MS = 5 * 60_000;
const RETRY_INTERVAL_MS = 30_000;
const DRAIN_LOCK = 'cordn-outbox-drain';

/** In-memory bookkeeping for hydrated entries (seq → record). The chatOutbox
 *  projection is the reactive UI; this map is for retry/lookup plumbing. */
const entriesBySeq = new Map<number, StoredChatOutboxRecord>();

let lastSeq = 0;
let draining = false;
let drainAgain = false;
let retryTimer: ReturnType<typeof setInterval> | undefined;

function activePubkey(): string {
	const pubkey = manager.getActive()?.pubkey;
	return pubkey ? normalizePubKey(pubkey) : '';
}

function nextSeq(): number {
	// ponytail: time-derived monotonic seq; two tabs enqueuing in the same ms can
	// collide (last write wins) — hydrate-on-focus re-seeds, so it needs same-ms
	// cross-tab sends to bite. Per-tab counters + a lock would close it.
	lastSeq = Math.max(Date.now(), lastSeq + 1);
	return lastSeq;
}

function bubbleId(entry: Pick<StoredChatOutboxRecord, 'seq'>): string {
	return `${OUTBOX_ID_PREFIX}${entry.seq}`;
}

function outboxEntryToChatMessage(entry: StoredChatOutboxRecord): UiChatMessage {
	return {
		id: bubbleId(entry),
		eventId: bubbleId(entry),
		author: entry.ownerPubkey,
		text: entry.content,
		kind: ChatKinds.Text,
		createdAt: entry.createdAt,
		timeLabel: formatUnixTimestamp(entry.createdAt, true, false),
		dayLabel: formatUnixTimestamp(entry.createdAt, false, true),
		isOwn: true,
		deliveryState: entry.state === 'failed' ? 'error' : 'queued',
		reactions: [],
		tags: entry.tags,
		replyTo: entry.replyTo
			? {
					id: entry.replyTo.id,
					author: entry.replyTo.pubkey,
					authorLabel: entry.replyToAuthorLabel || entry.replyTo.pubkey,
					text: entry.replyTo.content
				}
			: undefined
	};
}

/** Was this intent's last attempt actually delivered? (Backlog check.) */
function isConfirmedDelivered(entry: StoredChatOutboxRecord): boolean {
	if (!entry.attemptedEventId) return false;
	return listChatGroupMessages(entry.groupId).some(
		(message) => message.id === entry.attemptedEventId
	);
}

function withinBackoff(entry: StoredChatOutboxRecord): boolean {
	if (entry.attempts <= 0 || !entry.lastAttemptAt) return false;
	const delay = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (entry.attempts - 1), RETRY_BACKOFF_MAX_MS);
	return Date.now() - entry.lastAttemptAt < delay;
}

function isAccountAbort(error: unknown): boolean {
	if (error instanceof DOMException && error.name === 'AbortError') return true;
	return /^You must be logged in/i.test(errorMessage(error));
}

/** Errors that no amount of retrying will fix: the intent is undeliverable. */
function isDefinitiveFailure(error: unknown): boolean {
	if (error instanceof RemovedFromGroupError) return true;
	const message = errorMessage(error);
	if (/unhealthy and is read-only/i.test(message)) return true;
	if (/Message content is required/i.test(message)) return true;
	return false;
}

function isAmbiguousTimeout(error: unknown): boolean {
	return /timed out/i.test(errorMessage(error));
}

async function dropEntry(entry: StoredChatOutboxRecord): Promise<void> {
	entriesBySeq.delete(entry.seq);
	const storage = await getChatStorage();
	await storage.deleteOutboxEntry(entry.seq);
	removePendingMessage(entry.groupId, bubbleId(entry));
}

async function persistEntry(entry: StoredChatOutboxRecord): Promise<void> {
	entriesBySeq.set(entry.seq, entry);
	const storage = await getChatStorage();
	await storage.putOutboxEntry(entry);
}

/** Enqueue a text send. Adds the optimistic bubble synchronously (instant
 *  feedback), persists the intent, then kicks the drain — online or not. */
export function enqueueTextMessage(input: {
	groupId: string;
	content: string;
	tags?: string[][];
	replyTo?: ChatMessageReplyTarget;
	/** Profile label for the optimistic reply preview (UX parity with live sends). */
	replyToAuthorLabel?: string;
}): void {
	const ownerPubkey = activePubkey();
	if (!ownerPubkey) return;
	const entry: StoredChatOutboxRecord = {
		seq: nextSeq(),
		groupId: input.groupId,
		ownerPubkey,
		content: input.content,
		tags: input.tags ?? [],
		replyTo: input.replyTo,
		replyToAuthorLabel: input.replyToAuthorLabel,
		createdAt: Date.now(),
		state: 'queued',
		attempts: 0
	};
	addPendingMessage(input.groupId, outboxEntryToChatMessage(entry));
	void persistEntry(entry).then(() => requestDrain());
}

/** User tapped a failed pending bubble: reset backoff and retry immediately. */
export function retryOutboxEntry(id: string): void {
	if (!id.startsWith(OUTBOX_ID_PREFIX)) return;
	const entry = entriesBySeq.get(Number(id.slice(OUTBOX_ID_PREFIX.length)));
	if (!entry) return;
	entry.state = 'queued';
	entry.attempts = 0;
	entry.lastAttemptAt = undefined;
	updatePendingMessage(entry.groupId, bubbleId(entry), (message) => ({
		...message,
		deliveryState: 'queued'
	}));
	void persistEntry(entry).then(() => requestDrain());
}

type AttemptOutcome = 'sent' | 'transient' | 'definitive' | 'abort';

async function attemptEntry(entry: StoredChatOutboxRecord): Promise<AttemptOutcome> {
	updatePendingMessage(entry.groupId, bubbleId(entry), (message) => ({
		...message,
		deliveryState: 'sending'
	}));
	try {
		await sendChatGroupMessage({
			groupId: entry.groupId,
			content: entry.content,
			tags: entry.tags,
			replyTo: entry.replyTo,
			// Persist the attempt marker (event id + ambiguous) BEFORE the post
			// leaves, so any ambiguous outcome can be resolved by backlog check.
			onSealed: async (eventId) => {
				entry.attemptedEventId = eventId;
				entry.state = 'ambiguous';
				await persistEntry(entry);
			}
		});
		return 'sent';
	} catch (error) {
		if (isAccountAbort(error)) return 'abort';
		if (isDefinitiveFailure(error)) {
			entry.state = 'failed';
			await persistEntry(entry);
			updatePendingMessage(entry.groupId, bubbleId(entry), (message) => ({
				...message,
				deliveryState: 'error'
			}));
			return 'definitive';
		}
		// ponytail: a transient failure where the sweep below could not run
		// (offline) still falls through to one harmless re-attempt per drain;
		// the request never reaches the coordinator while truly offline. A
		// flapping connection inside the sweep window is the residual risk —
		// server-side msg_post dedup by event id closes it for good.
		entry.attempts += 1;
		entry.lastAttemptAt = Date.now();
		entry.state = isAmbiguousTimeout(error) ? 'ambiguous' : 'queued';
		await persistEntry(entry);
		updatePendingMessage(entry.groupId, bubbleId(entry), (message) => ({
			...message,
			deliveryState: 'queued'
		}));
		return 'transient';
	}
}

async function drainPass(ownerPubkey: string): Promise<number> {
	// The resume gate must be awaited OUTSIDE the per-group operation lock
	// (sendChatGroupMessage takes it) — same deadlock rule as the UI action.
	const resume = getChatGroupResumePromise();
	if (resume) await resume.catch(() => undefined);

	const storage = await getChatStorage();
	let entries = await storage.listOutboxEntries(ownerPubkey);

	// One catch-up sweep resolves all ambiguous entries: after it, any landed
	// attempt is visible in the (reactive) message store. Reuses the single
	// watch machinery — no parallel fetch path. Dynamic import: the watch
	// module pulls the browser/Capacitor graph, which must stay out of tests.
	// ponytail: skipped while navigator.onLine is false (the sweep can't fetch);
	// ambiguous heads then simply wait for the next online drain trigger.
	const sweepDone =
		!browser || navigator.onLine
			? await (async () => {
					if (!entries.some((entry) => entry.state === 'ambiguous')) return true;
					const watch = await import('./chatGroupWatch.svelte');
					await watch.refreshWatchedGroups().catch(() => undefined);
					entries = await storage.listOutboxEntries(ownerPubkey);
					return true;
				})()
			: false;

	const byGroup = new Map<string, StoredChatOutboxRecord[]>();
	for (const entry of entries) {
		const list = byGroup.get(entry.groupId);
		if (list) list.push(entry);
		else byGroup.set(entry.groupId, [entry]);
	}

	for (const [groupId, groupEntries] of byGroup) {
		const group = getChatGroup(groupId);
		if (!group) {
			// Group deleted while queued — the intents die with it.
			for (const entry of groupEntries) await dropEntry(entry);
			continue;
		}
		if (isChatGroupRemoved(group) || isChatGroupPoisoned(group)) {
			for (const entry of groupEntries) {
				entry.state = 'failed';
				await persistEntry(entry);
				updatePendingMessage(groupId, bubbleId(entry), (message) => ({
					...message,
					deliveryState: 'error'
				}));
			}
			continue;
		}
		for (const entry of groupEntries) {
			if (isConfirmedDelivered(entry)) {
				await dropEntry(entry);
				continue;
			}
			// An ambiguous head is only retried after a successful confirm sweep
			// proved its event id absent; otherwise it blocks its group (FIFO).
			if (entry.state === 'ambiguous' && !sweepDone) break;
			if (withinBackoff(entry)) break;
			const outcome = await attemptEntry(entry);
			if (outcome === 'sent') {
				await dropEntry(entry);
				continue;
			}
			if (outcome === 'abort') return entries.length;
			break; // transient/definitive — head blocked, rest waits (MLS order)
		}
	}

	return (await storage.listOutboxEntries(ownerPubkey)).length;
}

async function runDrain(): Promise<void> {
	try {
		const ownerPubkey = activePubkey();
		if (!ownerPubkey) {
			// Logged out: nothing to drain — also drop the retry interval so it
			// doesn't tick forever against a no-op drain.
			if (retryTimer !== undefined) {
				clearInterval(retryTimer);
				retryTimer = undefined;
			}
			return;
		}
		await ensureGroupsLoaded();
		const remaining = await (browser && navigator.locks
			? navigator.locks.request(DRAIN_LOCK, () => drainPass(ownerPubkey))
			: drainPass(ownerPubkey));
		if (retryTimer === undefined && remaining > 0) {
			// ponytail: blunt 30s poll while the queue is non-empty; move onto the
			// watch driver's tick if coordinator-outage retries ever need finesse.
			retryTimer = setInterval(() => void requestDrain(), RETRY_INTERVAL_MS);
		} else if (retryTimer !== undefined && remaining === 0) {
			clearInterval(retryTimer);
			retryTimer = undefined;
		}
	} catch (error) {
		// Triggers are fire-and-forget; an unexpected drain error must not become
		// an unhandled rejection — the next trigger retries anyway.
		console.warn('[outbox] drain failed', error);
	}
}

let currentDrain: Promise<void> = Promise.resolve();

/** Coalescing entry point — safe to call from every trigger. Returns a promise
 *  that settles once the drain chain (including any re-run requested while a
 *  drain was in flight) has completed. */
export function requestDrain(): Promise<void> {
	if (draining) {
		drainAgain = true;
		return currentDrain;
	}
	draining = true;
	currentDrain = runDrain().finally(() => {
		draining = false;
		if (drainAgain) {
			drainAgain = false;
			return requestDrain();
		}
	});
	return currentDrain;
}

/** Rebuild the pending-message projection from durable storage. Called on
 *  load, account change, and regaining focus (another tab may have drained). */
export async function hydrateOutbox(): Promise<void> {
	if (draining) return; // the drain keeps the projection in sync
	const ownerPubkey = activePubkey();
	const storage = await getChatStorage();
	if (!ownerPubkey) {
		replaceAllPending({});
		entriesBySeq.clear();
		return;
	}
	const entries = await storage.listOutboxEntries(ownerPubkey);
	if (activePubkey() !== ownerPubkey) return; // account switched mid-read
	lastSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
	entriesBySeq.clear();
	for (const entry of entries) entriesBySeq.set(entry.seq, entry);
	const record: Record<string, UiChatMessage[]> = {};
	for (const entry of entries) {
		(record[entry.groupId] ??= []).push(outboxEntryToChatMessage(entry));
	}
	replaceAllPending(record);
}

if (browser) {
	manager.active$.subscribe(() => {
		void hydrateOutbox();
		requestDrain();
	});
	window.addEventListener('online', () => {
		void hydrateOutbox();
		requestDrain();
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			void hydrateOutbox();
			requestDrain();
		}
	});
	window.addEventListener('focus', () => {
		void hydrateOutbox();
		requestDrain();
	});
}
