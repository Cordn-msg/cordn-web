import { browser } from '$app/environment';

import type {
	StoredChatMessage,
	StoredChatSyncIssue
} from '$lib/services/chatGroupMessages.svelte';
import { traceChat } from '$lib/services/chatTrace';
import type { PendingEpochOperation } from '$lib/services/chatGroupProtocol';
import type { ChatMessageReplyTarget } from '$lib/chat/references';

export type ChatStorageBackend = 'indexeddb' | 'memory';

export type ChatGroupStateSnapshotStatus = 'healthy' | 'tentative';

export interface StoredChatGroupStateSnapshot {
	groupId: string;
	status: ChatGroupStateSnapshotStatus;
	epoch: string;
	cursor: number;
	createdAt: number;
	stateBytes: Uint8Array;
	triggerCursor?: number;
	triggerMessageId?: string;
}

export interface StoredChatGroupRecord {
	id: string;
	ownerPubkey?: string;
	coordinatorKey: string;
	createdAt: number;
	lastCursor: number;
	fetchCursor: number;
	status?: 'active' | 'removed' | 'poisoned';
	removedAtCursor?: number;
	poisonedAtCursor?: number;
	joinedWithKeyPackageRef?: string;
	joinEpoch?: string;
	/** The adopted group-document identity (spec §10: content address, document
	 *  cursor, state fingerprint) — the rank fallback needs to know WHICH
	 *  document the local state came from. Absent on records seeded before
	 *  this field existed (treated as unrankable → no fork adoption). */
	appliedDocument?: { address: string; cursor: number; fingerprint?: string };
	/** Epoch fingerprints (spec §10 detection) of the states this device has
	 *  held, keyed by epoch (retention-capped). What a document's `prev` chain
	 *  is compared against to tell an advance on our branch from a fork that
	 *  moved on (spec §8 descent check). */
	epochFingerprints?: Record<string, string>;
	/** Which side of a shared-leaf race this device's state is on (spec §10
	 *  step 1, coordinator order), recorded right after posting a Commit while
	 *  the pre-Commit state can still read the race. `live` — no competing
	 *  Commit from the shared leaf preceded ours; `dead` — one did, so the
	 *  group applied the sibling's. Cleared whenever a document is adopted. */
	branch?: { kind: 'live' | 'dead'; sinceEpoch: string };
	/** The last Commit from this device's own shared leaf that ingestion
	 *  skipped (a sibling's, spec §10), at the epoch it was skipped in. A
	 *  Commit posted from that same epoch afterwards lost the race to it. */
	skippedSiblingCommit?: { epoch: string; cursor: number };
	/** Missed-update evidence: a sealed payload that would not open (count of
	 *  unopenable payloads since the mark, cleared by a current-epoch decrypt).
	 *  Commits are refused while set; sends once the run reaches 2. */
	staleMark?: { cursor: number; unopenableCount: number };
	/** Retained per-epoch payload keys (epoch → base64 key): a lagging sender
	 *  seals under an epoch we already left; ts-mls keeps the matching inner
	 *  receiver material for 4 epochs. */
	formerPayloadKeys?: Record<string, string>;
	/** The state right after this device's own Commit produced the current
	 *  epoch, at that Commit's stream cursor — the epoch's commit point (spec
	 *  §8.5 gen-0 state, §10.3 rank). Published ahead of the live document,
	 *  once, when the live state has moved past it. */
	commitPoint?: { epoch: string; cursor: number; clientState: string; published?: boolean };
	/** The fork decision recorded for the fork epoch (spec §10): the winning
	 *  branch's fingerprint and what decided it. A decision from evidence is
	 *  not overturned by the rank fallback alone. */
	forkDecision?: {
		epoch: string;
		fingerprint: string;
		by: 'coordinator-order' | 'third-party' | 'rank';
	};
	/** Not-yet-delivered outbound epoch ops (mostly add-member Welcomes awaiting
	 *  Commit re-ingestion). Persisted on the group record so a reload before
	 *  finalization no longer strands a Welcome; the in-memory Map in
	 *  chatGroups.svelte.ts is rehydrated/cleared per owner in loadGroups(). */
	pendingEpochOperations?: PendingEpochOperation[];
}

export interface StoredChatGroupStateRecord {
	groupId: string;
	stateBytes: Uint8Array;
}

export interface StoredChatGroupSnapshotRecord {
	groupId: string;
	snapshots: StoredChatGroupStateSnapshot[];
}

export interface StoredChatGroupData extends StoredChatGroupRecord {
	stateBytes: Uint8Array;
	messages: StoredChatMessage[];
	syncIssues: StoredChatSyncIssue[];
	snapshots?: StoredChatGroupStateSnapshot[];
	/** Unread-ledger rows for the messages above (see StoredMessageLedgerRow);
	 *  storage writes them alongside the matching new message rows. */
	messageLedger?: StoredMessageLedgerRow[];
}

interface StoredChatMessageRecord extends StoredChatMessage {
	groupId: string;
}

interface StoredChatSyncIssueRecord extends StoredChatSyncIssue {
	groupId: string;
}

/** Durable unread-ledger row (docs/long-history.md decision 4): the facts the
 *  unread badge and mention list need, derived once per message so unread
 *  counts never scan history. Written for every persisted message that is
 *  countable (non-system, not our own) or references us. A row at
 *  `MESSAGE_LEDGER_BACKFILL_CURSOR` marks the group's one-time backfill done. */
export interface StoredMessageLedgerRow {
	groupId: string;
	cursor: number;
	/** Counts toward the unread badge (non-system, not our own). */
	countable?: boolean;
	/** For rows referencing us: the jump target's event id — the reference's own
	 *  id for plain mentions, the `e`-tag target for hidden aggregates (whose
	 *  own rows never render). */
	refTargetId?: string;
}

export const MESSAGE_LEDGER_BACKFILL_CURSOR = -1;

/** One picture kept in this account's own emoji collection: the bytes, so an
 *  emoji collected from a chat can be sent without its original host (which may
 *  refuse browser downloads, or may be gone). Local to the account, never a
 *  published NIP-30 set. */
export interface StoredEmojiCollectionRecord {
	ownerPubkey: string;
	/** Lowercase hex sha256 of `bytes` — the same picture is collected once. */
	id: string;
	/** Shortcode name, unique within the account's collection. */
	name: string;
	mime: string;
	filename: string;
	bytes: Uint8Array;
	addedAt: number;
}

export interface StoredChatKeyPackageRecord {
	id: string;
	ownerPubkey: string;
	label: string;
	isLastResort: boolean;
	keyPackageRef: string;
	keyPackageBytes: Uint8Array;
	privateKeyPackageBytes: Uint8Array;
	cipherSuite: string;
	createdAt: number;
	publishedCoordinatorKeys: string[];
}

/** Delivery lifecycle of a queued send intent. `ambiguous` = a coordinator post
 *  was in flight (or timed out) and may have landed — it must be confirmed
 *  against the backlog (by `attemptedEventId`) before any retry, because
 *  msg_post has no server-side dedup. */
export type StoredChatOutboxState = 'queued' | 'ambiguous' | 'failed';

/** A persisted send INTENT (plaintext payload, not ciphertext): drained by
 *  re-encrypting against the group's CURRENT MLS state at attempt time. This
 *  survives reloads/app close and makes epoch changes while offline a no-op. */
export interface StoredChatOutboxRecord {
	/** Client-generated monotonic key; also the order within a group (FIFO). */
	seq: number;
	groupId: string;
	/** Account that queued the send — drains only under its owner. */
	ownerPubkey: string;
	content: string;
	tags: string[][];
	replyTo?: ChatMessageReplyTarget;
	/** Resolved event kind of the intent (polls enqueue as kind 1068).
	 *  Absent = resolve as Text/ThreadReply from content + replyTo, as before. */
	kind?: number;
	createdAt: number;
	state: StoredChatOutboxState;
	/** Event id of the most recent MLS sealing of this intent (set before post). */
	attemptedEventId?: string;
	/** Transient-failure count; drives retry backoff only (no auto-fail). */
	attempts: number;
	/** Last transient-failure reason (held sends, coordinator errors) — shown
	 *  as the pending bubble's tooltip so a wedged clock explains itself. */
	lastError?: string;
	lastAttemptAt?: number;
	/** The send was held back because its custom emoji could not be prepared
	 *  (pack host unreadable, Blossom refused). Offers "send without emoji". */
	emojiBlocked?: boolean;
	/** Explicit "send without custom emoji": skip preparation and let the
	 *  shortcodes travel as text. */
	skipEmojiMedia?: boolean;
}

export interface ChatStorageCapabilities {
	backend: ChatStorageBackend;
	persistent: boolean;
	binary: boolean;
	supportsTransactions: boolean;
}

export interface ChatStorage {
	readonly capabilities: ChatStorageCapabilities;
	init(): Promise<void>;
	listGroups(ownerPubkey?: string): Promise<StoredChatGroupRecord[]>;
	getGroup(
		groupId: string,
		options?: { messageLimit?: number }
	): Promise<StoredChatGroupData | undefined>;
	/** Paginated history reads — the windowed-rendering seam (docs/long-history.md).
	 *  Ascending cursor order, boundaries exclusive: without bounds the newest
	 *  `limit` messages (tail page); with `before` the newest `limit` below it
	 *  (prepend page); with `after` (optionally capped by `before`) the oldest
	 *  `limit` above it (append page). */
	getGroupMessagesPage(
		groupId: string,
		options: { after?: number; before?: number; limit: number }
	): Promise<StoredChatMessage[]>;
	/** Which of these cursors already have durable message rows — windowed
	 *  ingest dedupe (docs/long-history.md decision 7). */
	getPersistedMessageCursors(groupId: string, cursors: number[]): Promise<Set<number>>;
	/** Unread-ledger rows (see StoredMessageLedgerRow), ascending by cursor,
	 *  including the backfill sentinel row. */
	listMessageLedgerRows(groupId: string): Promise<StoredMessageLedgerRow[]>;
	putMessageLedgerRows(rows: StoredMessageLedgerRow[]): Promise<void>;
	putGroup(group: StoredChatGroupData): Promise<void>;
	deleteGroup(groupId: string): Promise<void>;
	deleteGroupsByOwner(ownerPubkey: string): Promise<void>;
	listOutboxEntries(ownerPubkey?: string): Promise<StoredChatOutboxRecord[]>;
	putOutboxEntry(entry: StoredChatOutboxRecord): Promise<void>;
	deleteOutboxEntry(seq: number): Promise<void>;
	listKeyPackages(ownerPubkey?: string): Promise<StoredChatKeyPackageRecord[]>;
	getKeyPackage(keyPackageRef: string): Promise<StoredChatKeyPackageRecord | undefined>;
	replaceKeyPackages(records: StoredChatKeyPackageRecord[]): Promise<void>;
	deleteKeyPackage(keyPackageRef: string): Promise<void>;
	deleteKeyPackagesByOwner(ownerPubkey: string): Promise<void>;
	listEmojiCollection(ownerPubkey: string): Promise<StoredEmojiCollectionRecord[]>;
	putEmojiCollectionItem(item: StoredEmojiCollectionRecord): Promise<void>;
	deleteEmojiCollectionItem(ownerPubkey: string, id: string): Promise<void>;
	deleteEmojiCollectionByOwner(ownerPubkey: string): Promise<void>;
}

const DATABASE_NAME = 'cordn-web';
const DATABASE_VERSION = 7;
const GROUP_STORE = 'groups';
const GROUP_STATE_STORE = 'groupStates';
const MESSAGE_STORE = 'messages';
const SYNC_ISSUE_STORE = 'syncIssues';
const KEY_PACKAGE_STORE = 'keyPackages';
const SNAPSHOT_STORE = 'snapshots';
const OUTBOX_STORE = 'outbox';
const MESSAGE_LEDGER_STORE = 'messageLedger';
const EMOJI_COLLECTION_STORE = 'emojiCollection';

function cloneBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

function cloneMessage(message: StoredChatMessage): StoredChatMessage {
	return {
		...message,
		tags: message.tags.map((tag) => [...tag])
	};
}

function cloneIssue(issue: StoredChatSyncIssue): StoredChatSyncIssue {
	return { ...issue };
}

function cloneMessageRecord(message: StoredChatMessageRecord): StoredChatMessageRecord {
	return {
		...cloneMessage(message),
		groupId: message.groupId
	};
}

function cloneIssueRecord(issue: StoredChatSyncIssueRecord): StoredChatSyncIssueRecord {
	return {
		...cloneIssue(issue),
		groupId: issue.groupId
	};
}

function cloneSnapshot(snapshot: StoredChatGroupStateSnapshot): StoredChatGroupStateSnapshot {
	return {
		...snapshot,
		stateBytes: cloneBytes(snapshot.stateBytes)
	};
}

function cloneGroup(group: StoredChatGroupData): StoredChatGroupData {
	return {
		...group,
		stateBytes: cloneBytes(group.stateBytes),
		messages: group.messages.map(cloneMessage),
		syncIssues: group.syncIssues.map(cloneIssue),
		snapshots: group.snapshots?.map(cloneSnapshot)
	};
}

function cloneKeyPackage(record: StoredChatKeyPackageRecord): StoredChatKeyPackageRecord {
	return {
		...record,
		keyPackageBytes: cloneBytes(record.keyPackageBytes),
		privateKeyPackageBytes: cloneBytes(record.privateKeyPackageBytes),
		publishedCoordinatorKeys: [...record.publishedCoordinatorKeys]
	};
}

function cloneGroupRecord(group: StoredChatGroupData): StoredChatGroupRecord {
	const record = { ...group };
	delete (record as Partial<StoredChatGroupData>).stateBytes;
	delete (record as Partial<StoredChatGroupData>).messages;
	delete (record as Partial<StoredChatGroupData>).syncIssues;
	delete (record as Partial<StoredChatGroupData>).snapshots;
	delete (record as Partial<StoredChatGroupData>).messageLedger;
	return { ...record };
}

function cloneOutboxEntry(entry: StoredChatOutboxRecord): StoredChatOutboxRecord {
	return {
		...entry,
		tags: entry.tags.map((tag) => [...tag]),
		replyTo: entry.replyTo && { ...entry.replyTo, tags: entry.replyTo.tags.map((tag) => [...tag]) }
	};
}

function compareOutboxEntries(a: StoredChatOutboxRecord, b: StoredChatOutboxRecord) {
	return a.seq - b.seq;
}

function compareGroups(a: StoredChatGroupRecord, b: StoredChatGroupRecord) {
	return a.createdAt - b.createdAt;
}

function compareKeyPackages(a: StoredChatKeyPackageRecord, b: StoredChatKeyPackageRecord) {
	return b.createdAt - a.createdAt;
}

function materializeGroupData(params: {
	group: StoredChatGroupRecord & {
		stateBytes: Uint8Array;
		snapshots?: StoredChatGroupStateSnapshot[];
	};
	messages: StoredChatMessageRecord[];
	syncIssues: StoredChatSyncIssueRecord[];
}): StoredChatGroupData {
	return {
		...params.group,
		stateBytes: cloneBytes(params.group.stateBytes),
		messages: params.messages
			.filter((message) => message.groupId === params.group.id)
			.map(({ groupId, ...message }) => {
				void groupId;
				return cloneMessage(message);
			})
			.sort((a, b) => a.cursor - b.cursor),
		syncIssues: params.syncIssues
			.filter((issue) => issue.groupId === params.group.id)
			.map(({ groupId, ...issue }) => {
				void groupId;
				return cloneIssue(issue);
			})
			.sort((a, b) => a.cursor - b.cursor),
		snapshots: params.group.snapshots?.map(cloneSnapshot)
	};
}

class MemoryChatStorage implements ChatStorage {
	readonly capabilities: ChatStorageCapabilities;

	protected groups = new Map<string, StoredChatGroupData>();
	protected keyPackages = new Map<string, StoredChatKeyPackageRecord>();
	protected outboxEntries: StoredChatOutboxRecord[] = [];
	protected messageLedgerRows = new Map<string, Map<number, StoredMessageLedgerRow>>();
	protected emojiCollection = new Map<string, StoredEmojiCollectionRecord>();

	constructor(capabilities: ChatStorageCapabilities) {
		this.capabilities = capabilities;
	}

	async init(): Promise<void> {
		return;
	}

	async listGroups(ownerPubkey?: string): Promise<StoredChatGroupRecord[]> {
		return [...this.groups.values()]
			.filter((group) => (ownerPubkey ? group.ownerPubkey === ownerPubkey : true))
			.map(cloneGroupRecord)
			.sort(compareGroups);
	}

	async getGroup(
		groupId: string,
		options: { messageLimit?: number } = {}
	): Promise<StoredChatGroupData | undefined> {
		const group = this.groups.get(groupId);
		if (!group) return undefined;
		const data = cloneGroup(group);
		if (options.messageLimit !== undefined) {
			data.messages = data.messages.slice(Math.max(0, data.messages.length - options.messageLimit));
		}
		return data;
	}

	async getPersistedMessageCursors(groupId: string, cursors: number[]): Promise<Set<number>> {
		const stored = new Set(this.groups.get(groupId)?.messages.map((message) => message.cursor));
		return new Set(cursors.filter((cursor) => stored.has(cursor)));
	}

	async getGroupMessagesPage(
		groupId: string,
		{ after, before, limit }: { after?: number; before?: number; limit: number }
	): Promise<StoredChatMessage[]> {
		const group = this.groups.get(groupId);
		if (!group || limit <= 0) return [];
		const eligible = group.messages
			.filter(
				(message) =>
					(after === undefined || message.cursor > after) &&
					(before === undefined || message.cursor < before)
			)
			.sort((a, b) => a.cursor - b.cursor);
		const page =
			after === undefined
				? eligible.slice(Math.max(0, eligible.length - limit))
				: eligible.slice(0, limit);
		return page.map(cloneMessage);
	}

	async listMessageLedgerRows(groupId: string): Promise<StoredMessageLedgerRow[]> {
		return [...(this.messageLedgerRows.get(groupId)?.values() ?? [])]
			.map((row) => ({ ...row }))
			.sort((a, b) => a.cursor - b.cursor);
	}

	async putMessageLedgerRows(rows: StoredMessageLedgerRow[]): Promise<void> {
		for (const row of rows) {
			let byCursor = this.messageLedgerRows.get(row.groupId);
			if (!byCursor) {
				byCursor = new Map();
				this.messageLedgerRows.set(row.groupId, byCursor);
			}
			byCursor.set(row.cursor, { ...row });
		}
	}

	async putGroup(group: StoredChatGroupData): Promise<void> {
		const stored = cloneGroup(group);
		if (stored.snapshots && stored.snapshots.length === 0) {
			delete stored.snapshots;
		}
		// Ledger rows accumulate in their own map (never replaced): the group
		// data only carries rows for its current messages.
		if (stored.messageLedger?.length) {
			const rows = stored.messageLedger;
			delete stored.messageLedger;
			await this.putMessageLedgerRows(rows);
		}
		const existing = this.groups.get(group.id);
		if (existing) {
			// Windowed histories (docs/long-history.md): putGroup receives the
			// loaded window — merge so evicted rows are never lost from storage
			// (the IDB backend only ever adds rows).
			const byCursor = new Map(existing.messages.map((message) => [message.cursor, message]));
			for (const message of stored.messages) byCursor.set(message.cursor, message);
			stored.messages = [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
		}
		this.groups.set(group.id, stored);
	}

	async deleteGroup(groupId: string): Promise<void> {
		this.groups.delete(groupId);
		this.messageLedgerRows.delete(groupId);
	}

	async deleteGroupsByOwner(ownerPubkey: string): Promise<void> {
		for (const group of [...this.groups.values()]) {
			if (group.ownerPubkey === ownerPubkey) {
				await this.deleteGroup(group.id);
			}
		}
	}

	async listOutboxEntries(ownerPubkey?: string): Promise<StoredChatOutboxRecord[]> {
		return this.outboxEntries
			.filter((entry) => (ownerPubkey ? entry.ownerPubkey === ownerPubkey : true))
			.map(cloneOutboxEntry)
			.sort(compareOutboxEntries);
	}

	async putOutboxEntry(entry: StoredChatOutboxRecord): Promise<void> {
		const stored = cloneOutboxEntry(entry);
		const existing = this.outboxEntries.findIndex((candidate) => candidate.seq === entry.seq);
		if (existing >= 0) this.outboxEntries[existing] = stored;
		else this.outboxEntries.push(stored);
	}

	async deleteOutboxEntry(seq: number): Promise<void> {
		this.outboxEntries = this.outboxEntries.filter((entry) => entry.seq !== seq);
	}

	async listKeyPackages(ownerPubkey?: string): Promise<StoredChatKeyPackageRecord[]> {
		const records = [...this.keyPackages.values()].filter((entry) =>
			ownerPubkey ? entry.ownerPubkey === ownerPubkey : true
		);
		return records.map(cloneKeyPackage).sort(compareKeyPackages);
	}

	async getKeyPackage(keyPackageRef: string): Promise<StoredChatKeyPackageRecord | undefined> {
		const record = this.keyPackages.get(keyPackageRef);
		return record ? cloneKeyPackage(record) : undefined;
	}

	async replaceKeyPackages(records: StoredChatKeyPackageRecord[]): Promise<void> {
		this.keyPackages = new Map(
			records.map((record) => [record.keyPackageRef, cloneKeyPackage(record)])
		);
	}

	async deleteKeyPackage(keyPackageRef: string): Promise<void> {
		this.keyPackages.delete(keyPackageRef);
	}

	async deleteKeyPackagesByOwner(ownerPubkey: string): Promise<void> {
		for (const record of [...this.keyPackages.values()]) {
			if (record.ownerPubkey === ownerPubkey) {
				this.keyPackages.delete(record.keyPackageRef);
			}
		}
	}

	async listEmojiCollection(ownerPubkey: string): Promise<StoredEmojiCollectionRecord[]> {
		return [...this.emojiCollection.values()]
			.filter((item) => item.ownerPubkey === ownerPubkey)
			.map((item) => ({ ...item, bytes: cloneBytes(item.bytes) }))
			.sort((a, b) => a.addedAt - b.addedAt);
	}

	async putEmojiCollectionItem(item: StoredEmojiCollectionRecord): Promise<void> {
		this.emojiCollection.set(`${item.ownerPubkey}:${item.id}`, {
			...item,
			bytes: cloneBytes(item.bytes)
		});
	}

	async deleteEmojiCollectionItem(ownerPubkey: string, id: string): Promise<void> {
		this.emojiCollection.delete(`${ownerPubkey}:${id}`);
	}

	async deleteEmojiCollectionByOwner(ownerPubkey: string): Promise<void> {
		for (const key of [...this.emojiCollection.keys()]) {
			if (this.emojiCollection.get(key)?.ownerPubkey === ownerPubkey) {
				this.emojiCollection.delete(key);
			}
		}
	}
}

class IndexedDbChatStorage implements ChatStorage {
	readonly capabilities: ChatStorageCapabilities = {
		backend: 'indexeddb',
		persistent: true,
		binary: true,
		supportsTransactions: true
	};

	private database: IDBDatabase | null = null;

	/** Cursors already written to the message store this session, per group —
	 *  `putGroup`'s write-diff memo (see the writeMissing loop). Rows are only
	 *  ever deleted with their whole group, so `deleteGroup` drops the entry.
	 *  shortcut: a concurrent deleteGroup from ANOTHER tab resurrects the group
	 *  row without its message rows (today it resurrects both); harmless while
	 *  the app is effectively single-tab (Capacitor) — switch to write-through
	 *  at ingest if shared multi-tab IDB ever matters. */
	private durableMessageCursors = new Map<string, Set<number>>();

	async init(): Promise<void> {
		if (!browser) return;
		this.database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
			request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(GROUP_STORE)) {
					const store = db.createObjectStore(GROUP_STORE, { keyPath: 'id' });
					store.createIndex('ownerPubkey', 'ownerPubkey', { unique: false });
				} else {
					const store = request.transaction?.objectStore(GROUP_STORE);
					if (store && !store.indexNames.contains('ownerPubkey')) {
						store.createIndex('ownerPubkey', 'ownerPubkey', { unique: false });
					}
				}
				if (!db.objectStoreNames.contains(GROUP_STATE_STORE)) {
					db.createObjectStore(GROUP_STATE_STORE, { keyPath: 'groupId' });
				}
				if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
					const store = db.createObjectStore(MESSAGE_STORE, { keyPath: ['groupId', 'cursor'] });
					store.createIndex('groupId', 'groupId', { unique: false });
				}
				if (!db.objectStoreNames.contains(SYNC_ISSUE_STORE)) {
					const store = db.createObjectStore(SYNC_ISSUE_STORE, {
						keyPath: ['groupId', 'cursor', 'detail']
					});
					store.createIndex('groupId', 'groupId', { unique: false });
				}
				if (!db.objectStoreNames.contains(KEY_PACKAGE_STORE)) {
					db.createObjectStore(KEY_PACKAGE_STORE, { keyPath: 'keyPackageRef' });
				}
				if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
					db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'groupId' });
				}
				if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
					const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'seq' });
					store.createIndex('groupId', 'groupId', { unique: false });
					store.createIndex('ownerPubkey', 'ownerPubkey', { unique: false });
				}
				if (!db.objectStoreNames.contains(MESSAGE_LEDGER_STORE)) {
					const store = db.createObjectStore(MESSAGE_LEDGER_STORE, {
						keyPath: ['groupId', 'cursor']
					});
					store.createIndex('groupId', 'groupId', { unique: false });
				}
				if (!db.objectStoreNames.contains(EMOJI_COLLECTION_STORE)) {
					const store = db.createObjectStore(EMOJI_COLLECTION_STORE, {
						keyPath: ['ownerPubkey', 'id']
					});
					store.createIndex('ownerPubkey', 'ownerPubkey', { unique: false });
				}
			};
			request.onsuccess = () => resolve(request.result);
		});
	}

	private requireDatabase(): IDBDatabase {
		if (!this.database) {
			throw new Error('Chat storage is not initialized');
		}
		return this.database;
	}

	private async runTransaction<T>(
		storeName: string,
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore) => IDBRequest<T> | void,
		fallback?: () => T
	): Promise<T> {
		const db = this.requireDatabase();
		return new Promise<T>((resolve, reject) => {
			const transaction = db.transaction(storeName, mode);
			const store = transaction.objectStore(storeName);
			let request: IDBRequest<T> | void;
			try {
				request = operation(store);
			} catch (error) {
				reject(error);
				return;
			}
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => {
				if (!request && fallback) {
					resolve(fallback());
				}
			};
			if (request) {
				request.onerror = () => reject(request?.error ?? new Error('IndexedDB request failed'));
				request.onsuccess = () => resolve(request.result);
			}
		});
	}

	async listGroups(ownerPubkey?: string): Promise<StoredChatGroupRecord[]> {
		const groups = await this.runTransaction<StoredChatGroupRecord[]>(
			GROUP_STORE,
			'readonly',
			(store) => store.getAll() as IDBRequest<StoredChatGroupRecord[]>
		);
		return (groups ?? [])
			.filter((group) => (ownerPubkey ? group.ownerPubkey === ownerPubkey : true))
			.sort(compareGroups);
	}

	async getGroup(
		groupId: string,
		options: { messageLimit?: number } = {}
	): Promise<StoredChatGroupData | undefined> {
		const db = this.requireDatabase();
		return new Promise<StoredChatGroupData | undefined>((resolve, reject) => {
			const transaction = db.transaction(
				[GROUP_STORE, GROUP_STATE_STORE, MESSAGE_STORE, SYNC_ISSUE_STORE, SNAPSHOT_STORE],
				'readonly'
			);
			const groupStore = transaction.objectStore(GROUP_STORE);
			const stateStore = transaction.objectStore(GROUP_STATE_STORE);
			const messageIndex = transaction.objectStore(MESSAGE_STORE).index('groupId');
			const syncIssueIndex = transaction.objectStore(SYNC_ISSUE_STORE).index('groupId');
			const snapshotStore = transaction.objectStore(SNAPSHOT_STORE);
			const groupRequest = groupStore.get(groupId) as IDBRequest<StoredChatGroupRecord | undefined>;
			const stateRequest = stateStore.get(groupId) as IDBRequest<
				StoredChatGroupStateRecord | undefined
			>;
			let messageRecords: StoredChatMessageRecord[] = [];
			if (options.messageLimit === undefined) {
				const messageRequest = messageIndex.getAll(groupId) as IDBRequest<
					StoredChatMessageRecord[]
				>;
				messageRequest.onsuccess = () => {
					messageRecords = messageRequest.result;
				};
			} else {
				// Windowed load (docs/long-history.md): only the newest rows.
				const walk = messageIndex.openCursor(IDBKeyRange.only(groupId), 'prev');
				walk.onsuccess = () => {
					const cursor = walk.result;
					if (!cursor || messageRecords.length >= (options.messageLimit ?? 0)) {
						// The 'prev' walk collects newest-first; the store contract is
						// ascending like the unbounded getAll path and the memory backend.
						messageRecords.reverse();
						return;
					}
					messageRecords.push(cursor.value as StoredChatMessageRecord);
					cursor.continue();
				};
			}
			const syncIssueRequest = syncIssueIndex.getAll(groupId) as IDBRequest<
				StoredChatSyncIssueRecord[]
			>;
			const snapshotRequest = snapshotStore.get(groupId) as IDBRequest<
				StoredChatGroupSnapshotRecord | undefined
			>;
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => {
				const group = groupRequest.result;
				const state = stateRequest.result;
				if (!group || !state) {
					resolve(undefined);
					return;
				}
				const snapshotRecord = snapshotRequest.result;
				resolve(
					materializeGroupData({
						group: {
							...group,
							stateBytes: state.stateBytes,
							snapshots: snapshotRecord?.snapshots
						},
						messages: messageRecords,
						syncIssues: syncIssueRequest.result ?? []
					})
				);
			};
		});
	}

	async getGroupMessagesPage(
		groupId: string,
		{ after, before, limit }: { after?: number; before?: number; limit: number }
	): Promise<StoredChatMessage[]> {
		const db = this.requireDatabase();
		traceChat('idb getGroupMessagesPage', { groupId, after, before, limit });
		return new Promise<StoredChatMessage[]>((resolve, reject) => {
			const transaction = db.transaction([MESSAGE_STORE], 'readonly');
			const store = transaction.objectStore(MESSAGE_STORE);
			// Compound-key range over ['groupId', cursor]; ±Infinity opens a side to
			// the group's full span (Infinity is a valid number key).
			const range = IDBKeyRange.bound(
				[groupId, after === undefined ? -Infinity : after],
				[groupId, before === undefined ? Infinity : before],
				after !== undefined,
				before !== undefined
			);
			// Tail/prepend pages take the newest rows (walk back, flip at the end);
			// append pages take the oldest rows above `after`.
			const direction: IDBCursorDirection = after === undefined ? 'prev' : 'next';
			const page: StoredChatMessage[] = [];
			const request = store.openCursor(range, direction);
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor || page.length >= limit) {
					resolve(direction === 'prev' ? page.reverse() : page);
					return;
				}
				const { groupId: storedGroupId, ...message } = cursor.value as StoredChatMessageRecord;
				void storedGroupId;
				page.push(cloneMessage(message));
				cursor.continue();
			};
		});
	}

	async listMessageLedgerRows(groupId: string): Promise<StoredMessageLedgerRow[]> {
		const rows = await this.runTransaction<StoredMessageLedgerRow[]>(
			MESSAGE_LEDGER_STORE,
			'readonly',
			(store) => store.index('groupId').getAll(groupId) as IDBRequest<StoredMessageLedgerRow[]>
		);
		return (rows ?? []).map((row) => ({ ...row })).sort((a, b) => a.cursor - b.cursor);
	}

	async putMessageLedgerRows(rows: StoredMessageLedgerRow[]): Promise<void> {
		if (rows.length === 0) return;
		const db = this.requireDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction([MESSAGE_LEDGER_STORE], 'readwrite');
			const store = transaction.objectStore(MESSAGE_LEDGER_STORE);
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => resolve();
			for (const row of rows) store.put({ ...row });
		});
	}

	async getPersistedMessageCursors(groupId: string, cursors: number[]): Promise<Set<number>> {
		if (cursors.length === 0) return new Set();
		const db = this.requireDatabase();
		return new Promise<Set<number>>((resolve, reject) => {
			const transaction = db.transaction([MESSAGE_STORE], 'readonly');
			const store = transaction.objectStore(MESSAGE_STORE);
			const range = IDBKeyRange.bound(
				[groupId, Math.min(...cursors)],
				[groupId, Math.max(...cursors)]
			);
			const request = store.getAllKeys(range);
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
			request.onsuccess = () => {
				const found = new Set((request.result as Array<[string, number]>).map((key) => key[1]));
				resolve(new Set(cursors.filter((cursor) => found.has(cursor))));
			};
		});
	}

	async putGroup(group: StoredChatGroupData): Promise<void> {
		const db = this.requireDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(
				[
					GROUP_STORE,
					GROUP_STATE_STORE,
					MESSAGE_STORE,
					MESSAGE_LEDGER_STORE,
					SYNC_ISSUE_STORE,
					SNAPSHOT_STORE
				],
				'readwrite'
			);
			const groupStore = transaction.objectStore(GROUP_STORE);
			const stateStore = transaction.objectStore(GROUP_STATE_STORE);
			const messageStore = transaction.objectStore(MESSAGE_STORE);
			const messageLedgerStore = transaction.objectStore(MESSAGE_LEDGER_STORE);
			const syncIssueStore = transaction.objectStore(SYNC_ISSUE_STORE);
			const snapshotStore = transaction.objectStore(SNAPSHOT_STORE);
			const writtenMessageCursors: number[] = [];
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => {
				// Merged only on success: a failed transaction must not mark
				// unwritten cursors durable or the next putGroup would skip them.
				if (writtenMessageCursors.length > 0) {
					const durable = this.durableMessageCursors.get(group.id) ?? new Set<number>();
					for (const cursor of writtenMessageCursors) durable.add(cursor);
					this.durableMessageCursors.set(group.id, durable);
				}
				resolve();
			};

			const getExistingGroup = groupStore.get(group.id) as IDBRequest<
				StoredChatGroupRecord | undefined
			>;
			getExistingGroup.onerror = () =>
				reject(getExistingGroup.error ?? new Error('IndexedDB request failed'));
			getExistingGroup.onsuccess = () => {
				const existing = getExistingGroup.result;
				const existingFetchCursor = existing?.fetchCursor ?? 0;
				const isReactivatedGroup = group.status === 'active' && group.removedAtCursor === undefined;
				groupStore.put({
					...cloneGroupRecord(group),
					lastCursor: Math.max(existing?.lastCursor ?? 0, group.lastCursor),
					fetchCursor: Math.max(existing?.fetchCursor ?? 0, group.fetchCursor),
					status: existing?.status === 'removed' && !isReactivatedGroup ? 'removed' : group.status,
					removedAtCursor: isReactivatedGroup
						? undefined
						: existing?.removedAtCursor !== undefined && group.removedAtCursor !== undefined
							? Math.max(existing.removedAtCursor, group.removedAtCursor)
							: (existing?.removedAtCursor ?? group.removedAtCursor)
				});
				if (group.fetchCursor >= existingFetchCursor) {
					stateStore.put({ groupId: group.id, stateBytes: cloneBytes(group.stateBytes) });
				}
				if (group.snapshots && group.snapshots.length > 0) {
					snapshotStore.put({
						groupId: group.id,
						snapshots: group.snapshots.map(cloneSnapshot)
					});
				} else {
					snapshotStore.delete(group.id);
				}
				// Reconcile against the messages actually in storage: write only cursors
				// we don't already have. fastForwardGroup can advance fetchCursor past
				// messages that aren't durable yet (catchUpGroupFromChain recovers them
				// with cursor <= fetchCursor), so a cursor-based skip would silently drop
				// them on refresh. Checking the real set is robust to any such producer.
				// The known set is memoized per group per session (one getAllKeys lazy
				// init instead of one per persist) — see durableMessageCursors.
				if (group.messages.length > 0) {
					const rowsByCursor = new Map((group.messageLedger ?? []).map((row) => [row.cursor, row]));
					const writeMissing = (durable: Set<number>) => {
						for (const message of group.messages) {
							if (durable.has(message.cursor)) continue;
							writtenMessageCursors.push(message.cursor);
							messageStore.put(cloneMessageRecord({ ...message, groupId: group.id }));
							// Unread-ledger rows ride the matching message writes (same
							// transaction, same new-only gate).
							const row = rowsByCursor.get(message.cursor);
							if (row) messageLedgerStore.put({ ...row, groupId: group.id });
						}
					};
					const durable = this.durableMessageCursors.get(group.id);
					if (durable) {
						writeMissing(durable);
					} else {
						const storedKeys = messageStore.index('groupId').getAllKeys(group.id);
						storedKeys.onsuccess = () => {
							const known = new Set(storedKeys.result.map((key) => (key as [string, number])[1]));
							this.durableMessageCursors.set(group.id, known);
							writeMissing(known);
						};
					}
				}
			};
			for (const issue of group.syncIssues) {
				syncIssueStore.put(cloneIssueRecord({ ...issue, groupId: group.id }));
			}
		});
	}

	async deleteGroup(groupId: string): Promise<void> {
		this.durableMessageCursors.delete(groupId);
		const db = this.requireDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(
				[
					GROUP_STORE,
					GROUP_STATE_STORE,
					MESSAGE_STORE,
					MESSAGE_LEDGER_STORE,
					SYNC_ISSUE_STORE,
					SNAPSHOT_STORE,
					OUTBOX_STORE
				],
				'readwrite'
			);
			const groupStore = transaction.objectStore(GROUP_STORE);
			const stateStore = transaction.objectStore(GROUP_STATE_STORE);
			const messageStore = transaction.objectStore(MESSAGE_STORE);
			const messageIndex = messageStore.index('groupId');
			const messageLedgerStore = transaction.objectStore(MESSAGE_LEDGER_STORE);
			const messageLedgerIndex = messageLedgerStore.index('groupId');
			const syncIssueStore = transaction.objectStore(SYNC_ISSUE_STORE);
			const syncIssueIndex = syncIssueStore.index('groupId');
			const snapshotStore = transaction.objectStore(SNAPSHOT_STORE);
			const outboxStore = transaction.objectStore(OUTBOX_STORE);
			const outboxIndex = outboxStore.index('groupId');
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => resolve();
			groupStore.delete(groupId);
			stateStore.delete(groupId);
			snapshotStore.delete(groupId);
			const deleteMessages = messageIndex.openKeyCursor(IDBKeyRange.only(groupId));
			deleteMessages.onsuccess = () => {
				const cursor = deleteMessages.result;
				if (!cursor) return;
				messageStore.delete(cursor.primaryKey);
				cursor.continue();
			};
			const deleteLedger = messageLedgerIndex.openKeyCursor(IDBKeyRange.only(groupId));
			deleteLedger.onsuccess = () => {
				const cursor = deleteLedger.result;
				if (!cursor) return;
				messageLedgerStore.delete(cursor.primaryKey);
				cursor.continue();
			};
			const deleteIssues = syncIssueIndex.openKeyCursor(IDBKeyRange.only(groupId));
			deleteIssues.onsuccess = () => {
				const cursor = deleteIssues.result;
				if (!cursor) return;
				syncIssueStore.delete(cursor.primaryKey);
				cursor.continue();
			};
			// Queued send intents die with their group — there is no one left to deliver to.
			const deleteOutbox = outboxIndex.openKeyCursor(IDBKeyRange.only(groupId));
			deleteOutbox.onsuccess = () => {
				const cursor = deleteOutbox.result;
				if (!cursor) return;
				outboxStore.delete(cursor.primaryKey);
				cursor.continue();
			};
		});
	}

	async deleteGroupsByOwner(ownerPubkey: string): Promise<void> {
		const groups = await this.listGroups(ownerPubkey);
		for (const group of groups) {
			await this.deleteGroup(group.id);
		}
	}

	async listKeyPackages(ownerPubkey?: string): Promise<StoredChatKeyPackageRecord[]> {
		const records = await this.runTransaction<StoredChatKeyPackageRecord[]>(
			KEY_PACKAGE_STORE,
			'readonly',
			(store) => store.getAll() as IDBRequest<StoredChatKeyPackageRecord[]>
		);
		return (records ?? [])
			.filter((entry) => (ownerPubkey ? entry.ownerPubkey === ownerPubkey : true))
			.map(cloneKeyPackage)
			.sort(compareKeyPackages);
	}

	async getKeyPackage(keyPackageRef: string): Promise<StoredChatKeyPackageRecord | undefined> {
		const record = await this.runTransaction<StoredChatKeyPackageRecord | undefined>(
			KEY_PACKAGE_STORE,
			'readonly',
			(store) => store.get(keyPackageRef) as IDBRequest<StoredChatKeyPackageRecord | undefined>
		);
		return record ? cloneKeyPackage(record) : undefined;
	}

	async replaceKeyPackages(records: StoredChatKeyPackageRecord[]): Promise<void> {
		const db = this.requireDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(KEY_PACKAGE_STORE, 'readwrite');
			const store = transaction.objectStore(KEY_PACKAGE_STORE);
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => resolve();
			store.clear();
			for (const record of records) {
				store.put(cloneKeyPackage(record));
			}
		});
	}

	async deleteKeyPackage(keyPackageRef: string): Promise<void> {
		await this.runTransaction<void>(
			KEY_PACKAGE_STORE,
			'readwrite',
			(store) => {
				store.delete(keyPackageRef);
			},
			() => undefined
		);
	}

	async deleteKeyPackagesByOwner(ownerPubkey: string): Promise<void> {
		const records = await this.listKeyPackages(ownerPubkey);
		for (const record of records) {
			await this.deleteKeyPackage(record.keyPackageRef);
		}
	}

	async listOutboxEntries(ownerPubkey?: string): Promise<StoredChatOutboxRecord[]> {
		const entries = await this.runTransaction<StoredChatOutboxRecord[]>(
			OUTBOX_STORE,
			'readonly',
			(store) =>
				(ownerPubkey
					? store.index('ownerPubkey').getAll(ownerPubkey)
					: store.getAll()) as IDBRequest<StoredChatOutboxRecord[]>
		);
		return (entries ?? []).map(cloneOutboxEntry).sort(compareOutboxEntries);
	}

	async putOutboxEntry(entry: StoredChatOutboxRecord): Promise<void> {
		await this.runTransaction<void>(
			OUTBOX_STORE,
			'readwrite',
			(store) => {
				store.put(cloneOutboxEntry(entry));
			},
			() => undefined
		);
	}

	async deleteOutboxEntry(seq: number): Promise<void> {
		await this.runTransaction<void>(
			OUTBOX_STORE,
			'readwrite',
			(store) => {
				store.delete(seq);
			},
			() => undefined
		);
	}

	async listEmojiCollection(ownerPubkey: string): Promise<StoredEmojiCollectionRecord[]> {
		const records = await this.runTransaction<StoredEmojiCollectionRecord[]>(
			EMOJI_COLLECTION_STORE,
			'readonly',
			(store) =>
				store.index('ownerPubkey').getAll(ownerPubkey) as IDBRequest<StoredEmojiCollectionRecord[]>
		);
		return (records ?? [])
			.map((record) => ({ ...record, bytes: cloneBytes(record.bytes) }))
			.sort((a, b) => a.addedAt - b.addedAt);
	}

	async putEmojiCollectionItem(item: StoredEmojiCollectionRecord): Promise<void> {
		await this.runTransaction<void>(
			EMOJI_COLLECTION_STORE,
			'readwrite',
			(store) => {
				store.put({ ...item, bytes: cloneBytes(item.bytes) });
			},
			() => undefined
		);
	}

	async deleteEmojiCollectionItem(ownerPubkey: string, id: string): Promise<void> {
		await this.runTransaction<void>(
			EMOJI_COLLECTION_STORE,
			'readwrite',
			(store) => {
				store.delete([ownerPubkey, id]);
			},
			() => undefined
		);
	}

	async deleteEmojiCollectionByOwner(ownerPubkey: string): Promise<void> {
		for (const item of await this.listEmojiCollection(ownerPubkey)) {
			await this.deleteEmojiCollectionItem(ownerPubkey, item.id);
		}
	}
}

let storagePromise: Promise<ChatStorage> | null = null;

async function canUseIndexedDb(): Promise<boolean> {
	if (!browser || typeof indexedDB === 'undefined') return false;
	try {
		const testName = `${DATABASE_NAME}-probe`;
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(testName, 1);
			request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
			request.onupgradeneeded = () => {
				const probeDb = request.result;
				if (!probeDb.objectStoreNames.contains('probe')) {
					probeDb.createObjectStore('probe');
				}
			};
			request.onsuccess = () => resolve(request.result);
		});
		db.close();
		indexedDB.deleteDatabase(testName);
		return true;
	} catch {
		return false;
	}
}

async function createChatStorage(): Promise<ChatStorage> {
	if (await canUseIndexedDb()) {
		const storage = new IndexedDbChatStorage();
		await storage.init();
		return storage;
	}

	const storage = new MemoryChatStorage({
		backend: 'memory',
		persistent: false,
		binary: false,
		supportsTransactions: false
	});
	await storage.init();
	return storage;
}

export async function getChatStorage(): Promise<ChatStorage> {
	storagePromise ??= createChatStorage();
	return storagePromise;
}
