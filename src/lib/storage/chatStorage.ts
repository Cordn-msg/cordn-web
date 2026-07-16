import { browser } from '$app/environment';

import type {
	StoredChatMessage,
	StoredChatSyncIssue
} from '$lib/services/chatGroupMessages.svelte';

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
}

interface StoredChatMessageRecord extends StoredChatMessage {
	groupId: string;
}

interface StoredChatSyncIssueRecord extends StoredChatSyncIssue {
	groupId: string;
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
	getGroup(groupId: string): Promise<StoredChatGroupData | undefined>;
	putGroup(group: StoredChatGroupData): Promise<void>;
	deleteGroup(groupId: string): Promise<void>;
	deleteGroupsByOwner(ownerPubkey: string): Promise<void>;
	listKeyPackages(ownerPubkey?: string): Promise<StoredChatKeyPackageRecord[]>;
	getKeyPackage(keyPackageRef: string): Promise<StoredChatKeyPackageRecord | undefined>;
	putKeyPackage(record: StoredChatKeyPackageRecord): Promise<void>;
	replaceKeyPackages(records: StoredChatKeyPackageRecord[]): Promise<void>;
	deleteKeyPackage(keyPackageRef: string): Promise<void>;
	deleteKeyPackagesByOwner(ownerPubkey: string): Promise<void>;
}

const DATABASE_NAME = 'cordn-web';
const DATABASE_VERSION = 4;
const GROUP_STORE = 'groups';
const GROUP_STATE_STORE = 'groupStates';
const MESSAGE_STORE = 'messages';
const SYNC_ISSUE_STORE = 'syncIssues';
const KEY_PACKAGE_STORE = 'keyPackages';
const SNAPSHOT_STORE = 'snapshots';

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
	return { ...record };
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

	async getGroup(groupId: string): Promise<StoredChatGroupData | undefined> {
		const group = this.groups.get(groupId);
		return group ? cloneGroup(group) : undefined;
	}

	async putGroup(group: StoredChatGroupData): Promise<void> {
		const stored = cloneGroup(group);
		if (stored.snapshots && stored.snapshots.length === 0) {
			delete stored.snapshots;
		}
		this.groups.set(group.id, stored);
	}

	async deleteGroup(groupId: string): Promise<void> {
		this.groups.delete(groupId);
	}

	async deleteGroupsByOwner(ownerPubkey: string): Promise<void> {
		for (const group of [...this.groups.values()]) {
			if (group.ownerPubkey === ownerPubkey) {
				await this.deleteGroup(group.id);
			}
		}
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

	async putKeyPackage(record: StoredChatKeyPackageRecord): Promise<void> {
		this.keyPackages.set(record.keyPackageRef, cloneKeyPackage(record));
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
}

class IndexedDbChatStorage implements ChatStorage {
	readonly capabilities: ChatStorageCapabilities = {
		backend: 'indexeddb',
		persistent: true,
		binary: true,
		supportsTransactions: true
	};

	private database: IDBDatabase | null = null;

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

	async getGroup(groupId: string): Promise<StoredChatGroupData | undefined> {
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
			const messageRequest = messageIndex.getAll(groupId) as IDBRequest<StoredChatMessageRecord[]>;
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
						messages: messageRequest.result ?? [],
						syncIssues: syncIssueRequest.result ?? []
					})
				);
			};
		});
	}

	async putGroup(group: StoredChatGroupData): Promise<void> {
		const db = this.requireDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(
				[GROUP_STORE, GROUP_STATE_STORE, MESSAGE_STORE, SYNC_ISSUE_STORE, SNAPSHOT_STORE],
				'readwrite'
			);
			const groupStore = transaction.objectStore(GROUP_STORE);
			const stateStore = transaction.objectStore(GROUP_STATE_STORE);
			const messageStore = transaction.objectStore(MESSAGE_STORE);
			const syncIssueStore = transaction.objectStore(SYNC_ISSUE_STORE);
			const snapshotStore = transaction.objectStore(SNAPSHOT_STORE);
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => resolve();

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
				// One getAllKeys per putGroup is a cheap index scan (reads only; far lighter
				// than re-writing the whole history), and reads fresh each call so it stays
				// correct across tabs sharing this IDB. If a huge active group ever makes
				// this hot, add a durableMessageCursor fast-skip — see putGroup notes.
				if (group.messages.length > 0) {
					const storedKeys = messageStore.index('groupId').getAllKeys(group.id);
					storedKeys.onsuccess = () => {
						const stored = new Set(storedKeys.result.map((key) => (key as [string, number])[1]));
						for (const message of group.messages) {
							if (stored.has(message.cursor)) continue;
							messageStore.put(cloneMessageRecord({ ...message, groupId: group.id }));
						}
					};
				}
			};
			for (const issue of group.syncIssues) {
				syncIssueStore.put(cloneIssueRecord({ ...issue, groupId: group.id }));
			}
		});
	}

	async deleteGroup(groupId: string): Promise<void> {
		const db = this.requireDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(
				[GROUP_STORE, GROUP_STATE_STORE, MESSAGE_STORE, SYNC_ISSUE_STORE, SNAPSHOT_STORE],
				'readwrite'
			);
			const groupStore = transaction.objectStore(GROUP_STORE);
			const stateStore = transaction.objectStore(GROUP_STATE_STORE);
			const messageStore = transaction.objectStore(MESSAGE_STORE);
			const messageIndex = messageStore.index('groupId');
			const syncIssueStore = transaction.objectStore(SYNC_ISSUE_STORE);
			const syncIssueIndex = syncIssueStore.index('groupId');
			const snapshotStore = transaction.objectStore(SNAPSHOT_STORE);
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
			const deleteIssues = syncIssueIndex.openKeyCursor(IDBKeyRange.only(groupId));
			deleteIssues.onsuccess = () => {
				const cursor = deleteIssues.result;
				if (!cursor) return;
				syncIssueStore.delete(cursor.primaryKey);
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

	async putKeyPackage(record: StoredChatKeyPackageRecord): Promise<void> {
		await this.runTransaction<void>(
			KEY_PACKAGE_STORE,
			'readwrite',
			(store) => {
				store.put(cloneKeyPackage(record));
			},
			() => undefined
		);
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
