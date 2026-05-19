import { browser } from '$app/environment';

import type {
	StoredChatMessage,
	StoredChatSyncIssue
} from '$lib/services/chatGroupMessages.svelte';
import { base64ToBytes, bytesToBase64 } from 'ts-mls';

export type ChatStorageBackend = 'indexeddb' | 'local-storage' | 'memory';

export interface StoredChatGroupRecord {
	id: string;
	coordinatorKey: string;
	createdAt: number;
	lastCursor: number;
	fetchCursor: number;
	status?: 'active' | 'removed';
	removedAtCursor?: number;
}

export interface StoredChatGroupStateRecord {
	groupId: string;
	stateBytes: Uint8Array;
}

export interface StoredChatGroupData extends StoredChatGroupRecord {
	stateBytes: Uint8Array;
	messages: StoredChatMessage[];
	syncIssues: StoredChatSyncIssue[];
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
	consumedAt?: number;
	consumedByGroupId?: string;
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
	listGroups(): Promise<StoredChatGroupRecord[]>;
	getGroup(groupId: string): Promise<StoredChatGroupData | undefined>;
	putGroup(group: StoredChatGroupData): Promise<void>;
	deleteGroup(groupId: string): Promise<void>;
	listKeyPackages(ownerPubkey?: string): Promise<StoredChatKeyPackageRecord[]>;
	getKeyPackage(keyPackageRef: string): Promise<StoredChatKeyPackageRecord | undefined>;
	putKeyPackage(record: StoredChatKeyPackageRecord): Promise<void>;
	replaceKeyPackages(records: StoredChatKeyPackageRecord[]): Promise<void>;
	deleteKeyPackage(keyPackageRef: string): Promise<void>;
}

const GROUPS_STORAGE_KEY = 'cordn-chat-groups-v2';
const GROUP_MESSAGES_STORAGE_KEY = 'cordn-chat-group-messages-v2';
const GROUP_SYNC_ISSUES_STORAGE_KEY = 'cordn-chat-group-sync-issues-v2';
const KEY_PACKAGES_STORAGE_KEY = 'cordn-chat-key-packages-v2';
const DATABASE_NAME = 'cordn-web';
const DATABASE_VERSION = 2;
const GROUP_STORE = 'groups';
const GROUP_STATE_STORE = 'groupStates';
const MESSAGE_STORE = 'messages';
const SYNC_ISSUE_STORE = 'syncIssues';
const KEY_PACKAGE_STORE = 'keyPackages';

type LocalStorageGroupsPayload = {
	groups: Array<StoredChatGroupRecord & { stateBase64: string }>;
};

type LocalStorageMessagesPayload = {
	messages: StoredChatMessageRecord[];
};

type LocalStorageSyncIssuesPayload = {
	syncIssues: StoredChatSyncIssueRecord[];
};

type LocalStorageKeyPackagesPayload = {
	keyPackages: Array<
		Omit<StoredChatKeyPackageRecord, 'keyPackageBytes' | 'privateKeyPackageBytes'> & {
			keyPackageBase64: string;
			privateKeyPackageBase64: string;
		}
	>;
};

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

function cloneGroup(group: StoredChatGroupData): StoredChatGroupData {
	return {
		...group,
		stateBytes: cloneBytes(group.stateBytes),
		messages: group.messages.map(cloneMessage),
		syncIssues: group.syncIssues.map(cloneIssue)
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
	const {
		stateBytes: _stateBytes,
		messages: _messages,
		syncIssues: _syncIssues,
		...record
	} = group;
	return { ...record };
}

function compareGroups(a: StoredChatGroupRecord, b: StoredChatGroupRecord) {
	return a.createdAt - b.createdAt;
}

function compareKeyPackages(a: StoredChatKeyPackageRecord, b: StoredChatKeyPackageRecord) {
	return b.createdAt - a.createdAt;
}

function deserializeLocalStorageGroup(
	raw: StoredChatGroupRecord & { stateBase64: string }
): StoredChatGroupRecord & { stateBytes: Uint8Array } {
	return {
		id: raw.id,
		coordinatorKey: raw.coordinatorKey,
		createdAt: raw.createdAt,
		lastCursor: raw.lastCursor,
		fetchCursor: raw.fetchCursor,
		status: raw.status,
		removedAtCursor: raw.removedAtCursor,
		stateBytes: base64ToBytes(raw.stateBase64)
	};
}

function serializeLocalStorageGroup(
	raw: StoredChatGroupData
): StoredChatGroupRecord & { stateBase64: string } {
	const { stateBytes, messages: _messages, syncIssues: _syncIssues, ...group } = raw;
	return {
		...cloneGroupRecord({ ...group, stateBytes, messages: [], syncIssues: [] }),
		stateBase64: bytesToBase64(stateBytes)
	};
}

function materializeGroupData(params: {
	group: StoredChatGroupRecord & { stateBytes: Uint8Array };
	messages: StoredChatMessageRecord[];
	syncIssues: StoredChatSyncIssueRecord[];
}): StoredChatGroupData {
	return {
		...params.group,
		stateBytes: cloneBytes(params.group.stateBytes),
		messages: params.messages
			.filter((message) => message.groupId === params.group.id)
			.map(({ groupId: _groupId, ...message }) => cloneMessage(message))
			.sort((a, b) => a.cursor - b.cursor),
		syncIssues: params.syncIssues
			.filter((issue) => issue.groupId === params.group.id)
			.map(({ groupId: _groupId, ...issue }) => cloneIssue(issue))
			.sort((a, b) => a.cursor - b.cursor)
	};
}

function deserializeLocalStorageKeyPackage(
	raw: Omit<StoredChatKeyPackageRecord, 'keyPackageBytes' | 'privateKeyPackageBytes'> & {
		keyPackageBase64: string;
		privateKeyPackageBase64: string;
	}
): StoredChatKeyPackageRecord {
	return {
		...raw,
		keyPackageBytes: base64ToBytes(raw.keyPackageBase64),
		privateKeyPackageBytes: base64ToBytes(raw.privateKeyPackageBase64),
		publishedCoordinatorKeys: [...raw.publishedCoordinatorKeys]
	};
}

function serializeLocalStorageKeyPackage(raw: StoredChatKeyPackageRecord): Omit<
	StoredChatKeyPackageRecord,
	'keyPackageBytes' | 'privateKeyPackageBytes'
> & {
	keyPackageBase64: string;
	privateKeyPackageBase64: string;
} {
	const { keyPackageBytes, privateKeyPackageBytes, ...record } = raw;
	return {
		...record,
		publishedCoordinatorKeys: [...record.publishedCoordinatorKeys],
		keyPackageBase64: bytesToBase64(keyPackageBytes),
		privateKeyPackageBase64: bytesToBase64(privateKeyPackageBytes)
	};
}

class MemoryChatStorage implements ChatStorage {
	readonly capabilities: ChatStorageCapabilities;

	protected groups = new Map<string, StoredChatGroupData>();
	protected messages = new Map<string, StoredChatMessageRecord[]>();
	protected syncIssues = new Map<string, StoredChatSyncIssueRecord[]>();
	protected keyPackages = new Map<string, StoredChatKeyPackageRecord>();

	constructor(capabilities: ChatStorageCapabilities) {
		this.capabilities = capabilities;
	}

	async init(): Promise<void> {
		return;
	}

	async listGroups(): Promise<StoredChatGroupRecord[]> {
		return [...this.groups.values()].map(cloneGroupRecord).sort(compareGroups);
	}

	async getGroup(groupId: string): Promise<StoredChatGroupData | undefined> {
		const group = this.groups.get(groupId);
		return group ? cloneGroup(group) : undefined;
	}

	async putGroup(group: StoredChatGroupData): Promise<void> {
		this.groups.set(group.id, cloneGroup(group));
		this.messages.set(
			group.id,
			group.messages.map((message) => cloneMessageRecord({ ...message, groupId: group.id }))
		);
		this.syncIssues.set(
			group.id,
			group.syncIssues.map((issue) => cloneIssueRecord({ ...issue, groupId: group.id }))
		);
	}

	async deleteGroup(groupId: string): Promise<void> {
		this.groups.delete(groupId);
		this.messages.delete(groupId);
		this.syncIssues.delete(groupId);
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
}

class LocalStorageChatStorage extends MemoryChatStorage {
	constructor() {
		super({
			backend: 'local-storage',
			persistent: true,
			binary: false,
			supportsTransactions: false
		});
	}

	override async init(): Promise<void> {
		if (!browser) return;
		try {
			const rawGroups = localStorage.getItem(GROUPS_STORAGE_KEY);
			const rawMessages = localStorage.getItem(GROUP_MESSAGES_STORAGE_KEY);
			const rawSyncIssues = localStorage.getItem(GROUP_SYNC_ISSUES_STORAGE_KEY);
			if (rawGroups) {
				const parsed = JSON.parse(rawGroups) as LocalStorageGroupsPayload;
				const parsedMessages = rawMessages
					? ((JSON.parse(rawMessages) as LocalStorageMessagesPayload).messages ?? [])
					: [];
				const parsedSyncIssues = rawSyncIssues
					? ((JSON.parse(rawSyncIssues) as LocalStorageSyncIssuesPayload).syncIssues ?? [])
					: [];
				this.groups = new Map(
					(parsed.groups ?? []).map((group) => {
						const deserialized = deserializeLocalStorageGroup(group);
						return [
							deserialized.id,
							materializeGroupData({
								group: deserialized,
								messages: parsedMessages,
								syncIssues: parsedSyncIssues
							})
						];
					})
				);
				this.messages = new Map(
					this.groups
						.keys()
						.map((groupId) => [
							groupId,
							parsedMessages
								.filter((message) => message.groupId === groupId)
								.map(cloneMessageRecord)
						])
				);
				this.syncIssues = new Map(
					this.groups
						.keys()
						.map((groupId) => [
							groupId,
							parsedSyncIssues.filter((issue) => issue.groupId === groupId).map(cloneIssueRecord)
						])
				);
			}
			const rawKeyPackages = localStorage.getItem(KEY_PACKAGES_STORAGE_KEY);
			if (rawKeyPackages) {
				const parsed = JSON.parse(rawKeyPackages) as LocalStorageKeyPackagesPayload;
				this.keyPackages = new Map(
					(parsed.keyPackages ?? []).map((record) => [
						record.keyPackageRef,
						deserializeLocalStorageKeyPackage(record)
					])
				);
			}
		} catch {
			this.groups.clear();
			this.messages.clear();
			this.syncIssues.clear();
			this.keyPackages.clear();
		}
	}

	private persistGroups() {
		if (!browser) return;
		const payload: LocalStorageGroupsPayload = {
			groups: [...this.groups.values()].map(serializeLocalStorageGroup)
		};
		localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(payload));
	}

	private persistMessages() {
		if (!browser) return;
		const payload: LocalStorageMessagesPayload = {
			messages: [...this.messages.values()].flat().map(cloneMessageRecord)
		};
		localStorage.setItem(GROUP_MESSAGES_STORAGE_KEY, JSON.stringify(payload));
	}

	private persistSyncIssues() {
		if (!browser) return;
		const payload: LocalStorageSyncIssuesPayload = {
			syncIssues: [...this.syncIssues.values()].flat().map(cloneIssueRecord)
		};
		localStorage.setItem(GROUP_SYNC_ISSUES_STORAGE_KEY, JSON.stringify(payload));
	}

	private persistKeyPackages() {
		if (!browser) return;
		const payload: LocalStorageKeyPackagesPayload = {
			keyPackages: [...this.keyPackages.values()].map(serializeLocalStorageKeyPackage)
		};
		localStorage.setItem(KEY_PACKAGES_STORAGE_KEY, JSON.stringify(payload));
	}

	override async putGroup(group: StoredChatGroupData): Promise<void> {
		await super.putGroup(group);
		this.persistGroups();
		this.persistMessages();
		this.persistSyncIssues();
	}

	override async deleteGroup(groupId: string): Promise<void> {
		await super.deleteGroup(groupId);
		this.persistGroups();
		this.persistMessages();
		this.persistSyncIssues();
	}

	override async putKeyPackage(record: StoredChatKeyPackageRecord): Promise<void> {
		await super.putKeyPackage(record);
		this.persistKeyPackages();
	}

	override async replaceKeyPackages(records: StoredChatKeyPackageRecord[]): Promise<void> {
		await super.replaceKeyPackages(records);
		this.persistKeyPackages();
	}

	override async deleteKeyPackage(keyPackageRef: string): Promise<void> {
		await super.deleteKeyPackage(keyPackageRef);
		this.persistKeyPackages();
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
					db.createObjectStore(GROUP_STORE, { keyPath: 'id' });
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

	async listGroups(): Promise<StoredChatGroupRecord[]> {
		const groups = await this.runTransaction<StoredChatGroupRecord[]>(
			GROUP_STORE,
			'readonly',
			(store) => store.getAll() as IDBRequest<StoredChatGroupRecord[]>
		);
		return (groups ?? []).sort(compareGroups);
	}

	async getGroup(groupId: string): Promise<StoredChatGroupData | undefined> {
		const db = this.requireDatabase();
		return new Promise<StoredChatGroupData | undefined>((resolve, reject) => {
			const transaction = db.transaction(
				[GROUP_STORE, GROUP_STATE_STORE, MESSAGE_STORE, SYNC_ISSUE_STORE],
				'readonly'
			);
			const groupStore = transaction.objectStore(GROUP_STORE);
			const stateStore = transaction.objectStore(GROUP_STATE_STORE);
			const messageIndex = transaction.objectStore(MESSAGE_STORE).index('groupId');
			const syncIssueIndex = transaction.objectStore(SYNC_ISSUE_STORE).index('groupId');
			const groupRequest = groupStore.get(groupId) as IDBRequest<StoredChatGroupRecord | undefined>;
			const stateRequest = stateStore.get(groupId) as IDBRequest<
				StoredChatGroupStateRecord | undefined
			>;
			const messageRequest = messageIndex.getAll(groupId) as IDBRequest<StoredChatMessageRecord[]>;
			const syncIssueRequest = syncIssueIndex.getAll(groupId) as IDBRequest<
				StoredChatSyncIssueRecord[]
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
				resolve(
					materializeGroupData({
						group: { ...group, stateBytes: state.stateBytes },
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
				[GROUP_STORE, GROUP_STATE_STORE, MESSAGE_STORE, SYNC_ISSUE_STORE],
				'readwrite'
			);
			const groupStore = transaction.objectStore(GROUP_STORE);
			const stateStore = transaction.objectStore(GROUP_STATE_STORE);
			const messageStore = transaction.objectStore(MESSAGE_STORE);
			const messageIndex = messageStore.index('groupId');
			const syncIssueStore = transaction.objectStore(SYNC_ISSUE_STORE);
			const syncIssueIndex = syncIssueStore.index('groupId');
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => resolve();
			groupStore.put(cloneGroupRecord(group));
			stateStore.put({ groupId: group.id, stateBytes: cloneBytes(group.stateBytes) });
			const deleteMessages = messageIndex.openKeyCursor(IDBKeyRange.only(group.id));
			deleteMessages.onsuccess = () => {
				const cursor = deleteMessages.result;
				if (!cursor) return;
				messageStore.delete(cursor.primaryKey);
				cursor.continue();
			};
			const deleteIssues = syncIssueIndex.openKeyCursor(IDBKeyRange.only(group.id));
			deleteIssues.onsuccess = () => {
				const cursor = deleteIssues.result;
				if (!cursor) return;
				syncIssueStore.delete(cursor.primaryKey);
				cursor.continue();
			};
			for (const message of group.messages) {
				messageStore.put(cloneMessageRecord({ ...message, groupId: group.id }));
			}
			for (const issue of group.syncIssues) {
				syncIssueStore.put(cloneIssueRecord({ ...issue, groupId: group.id }));
			}
		});
	}

	async deleteGroup(groupId: string): Promise<void> {
		const db = this.requireDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(
				[GROUP_STORE, GROUP_STATE_STORE, MESSAGE_STORE, SYNC_ISSUE_STORE],
				'readwrite'
			);
			const groupStore = transaction.objectStore(GROUP_STORE);
			const stateStore = transaction.objectStore(GROUP_STATE_STORE);
			const messageStore = transaction.objectStore(MESSAGE_STORE);
			const messageIndex = messageStore.index('groupId');
			const syncIssueStore = transaction.objectStore(SYNC_ISSUE_STORE);
			const syncIssueIndex = syncIssueStore.index('groupId');
			transaction.onerror = () =>
				reject(transaction.error ?? new Error('IndexedDB transaction failed'));
			transaction.oncomplete = () => resolve();
			groupStore.delete(groupId);
			stateStore.delete(groupId);
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

function canUseLocalStorage(): boolean {
	if (!browser) return false;
	try {
		const key = 'cordn-storage-probe';
		localStorage.setItem(key, '1');
		localStorage.removeItem(key);
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

	if (canUseLocalStorage()) {
		const storage = new LocalStorageChatStorage();
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
