import { browser } from '$app/environment';
import { listChatGroupMembers, type StoredChatGroup } from './chatGroups.svelte';

/**
 * User-defined chat folders (Telegram-style list filters): explicit group
 * membership, device-local per owner account. Same persistence model as
 * chatGroupPins — one localStorage key per owner pubkey, loaded on account
 * change, deleted on logout. The fixed All/DMs/Groups tabs are derived, not
 * stored; only custom folders persist.
 */
export interface ChatGroupFolder {
	id: string;
	name: string;
	groupIds: string[];
}

export type ChatFolderSelection = 'all' | 'dms' | 'groups' | `folder:${string}`;

const STORAGE_KEY = 'cordn-chat-group-folders';
const FOLDER_NAME_MAX = 30;
export const CHAT_FOLDER_NAME_MAX = FOLDER_NAME_MAX;
const RESERVED_FOLDER_NAMES = new Set(['all', 'dms', 'groups']);
const FOLDER_KEY_PREFIX = 'folder:';

const chatGroupFoldersStore = $state({
	folders: [] as ChatGroupFolder[],
	selected: 'all' as ChatFolderSelection
});

let activeFoldersStorageKey = getFoldersStorageKey();

function getFoldersStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

function saveFolders() {
	if (!browser) return;
	localStorage.setItem(activeFoldersStorageKey, JSON.stringify(chatGroupFoldersStore.folders));
}

/** Defensive parse of persisted JSON: malformed entries are dropped, never thrown. */
function parsePersistedFolders(raw: string | null): ChatGroupFolder[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const folders: ChatGroupFolder[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue;
		const { id, name, groupIds } = entry as Record<string, unknown>;
		if (typeof id !== 'string' || !id) continue;
		const trimmed = typeof name === 'string' ? name.trim().slice(0, FOLDER_NAME_MAX) : '';
		if (!trimmed) continue;
		folders.push({
			id,
			name: trimmed,
			groupIds: Array.isArray(groupIds)
				? groupIds.filter((groupId): groupId is string => typeof groupId === 'string')
				: []
		});
	}
	return folders;
}

/** '' = valid. Reserved built-in names and case-insensitive duplicates are rejected. */
export function validateChatGroupFolderName(name: string, excludeFolderId?: string): string {
	const trimmed = name.trim();
	if (!trimmed) return 'Enter a name.';
	const lower = trimmed.toLowerCase();
	if (RESERVED_FOLDER_NAMES.has(lower)) return '“All”, “DMs” and “Groups” are built-in filters.';
	const clash = chatGroupFoldersStore.folders.some(
		(folder) => folder.id !== excludeFolderId && folder.name.toLowerCase() === lower
	);
	if (clash) return 'A folder with this name already exists.';
	return '';
}

export function loadChatGroupFoldersForOwner(ownerPubkey?: string) {
	if (!browser) return;
	activeFoldersStorageKey = getFoldersStorageKey(ownerPubkey);
	chatGroupFoldersStore.folders = parsePersistedFolders(
		localStorage.getItem(activeFoldersStorageKey)
	);
	chatGroupFoldersStore.selected = 'all';
}

export function deleteChatGroupFoldersForOwner(ownerPubkey: string) {
	if (!browser) return;
	const storageKey = getFoldersStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activeFoldersStorageKey === storageKey) {
		activeFoldersStorageKey = getFoldersStorageKey();
	}
	chatGroupFoldersStore.folders = [];
	chatGroupFoldersStore.selected = 'all';
}

export function listChatGroupFolders(): ChatGroupFolder[] {
	return chatGroupFoldersStore.folders;
}

export function createChatGroupFolder(
	name: string,
	groupIds: string[] = [],
	select = false
): { folder?: ChatGroupFolder; error?: string } {
	const error = validateChatGroupFolderName(name);
	if (error) return { error };
	const folder: ChatGroupFolder = {
		id: crypto.randomUUID(),
		name: name.trim(),
		groupIds: [...new Set(groupIds)]
	};
	chatGroupFoldersStore.folders = [...chatGroupFoldersStore.folders, folder];
	if (select) chatGroupFoldersStore.selected = `${FOLDER_KEY_PREFIX}${folder.id}`;
	saveFolders();
	return { folder };
}

export function updateChatGroupFolder(
	folderId: string,
	name: string,
	groupIds: string[]
): { error?: string } {
	const error = validateChatGroupFolderName(name, folderId);
	if (error) return { error };
	chatGroupFoldersStore.folders = chatGroupFoldersStore.folders.map((folder) =>
		folder.id === folderId
			? { ...folder, name: name.trim(), groupIds: [...new Set(groupIds)] }
			: folder
	);
	saveFolders();
	return {};
}

export function deleteChatGroupFolder(folderId: string) {
	chatGroupFoldersStore.folders = chatGroupFoldersStore.folders.filter(
		(folder) => folder.id !== folderId
	);
	if (chatGroupFoldersStore.selected === `${FOLDER_KEY_PREFIX}${folderId}`) {
		chatGroupFoldersStore.selected = 'all';
	}
	saveFolders();
}

export function toggleChatGroupFolderMembership(folderId: string, groupId: string) {
	const folder = chatGroupFoldersStore.folders.find((entry) => entry.id === folderId);
	if (!folder) return;
	const groupIds = folder.groupIds.includes(groupId)
		? folder.groupIds.filter((id) => id !== groupId)
		: [...folder.groupIds, groupId];
	chatGroupFoldersStore.folders = chatGroupFoldersStore.folders.map((entry) =>
		entry.id === folderId ? { ...entry, groupIds } : entry
	);
	saveFolders();
}

/** Drop memberships whose group no longer exists locally. Runs from the same
 *  prune as presence, so every deletion path (local delete, multi-device
 *  tombstone, coordinator purge) is covered once instead of per caller. */
export function pruneChatGroupFolders(keepGroupIds: Set<string>) {
	if (
		!chatGroupFoldersStore.folders.some((folder) =>
			folder.groupIds.some((groupId) => !keepGroupIds.has(groupId))
		)
	)
		return;
	chatGroupFoldersStore.folders = chatGroupFoldersStore.folders.map((folder) => ({
		...folder,
		groupIds: folder.groupIds.filter((groupId) => keepGroupIds.has(groupId))
	}));
	saveFolders();
}

/** Drop a deleted group's membership from every folder, mirroring removeChatGroupPin. */
export function removeChatGroupFromFolders(groupId: string) {
	if (!chatGroupFoldersStore.folders.some((folder) => folder.groupIds.includes(groupId))) return;
	chatGroupFoldersStore.folders = chatGroupFoldersStore.folders.map((folder) =>
		folder.groupIds.includes(groupId)
			? { ...folder, groupIds: folder.groupIds.filter((id) => id !== groupId) }
			: folder
	);
	saveFolders();
}

export function getChatFolderSelection(): ChatFolderSelection {
	return chatGroupFoldersStore.selected;
}

export function selectChatFolder(selection: ChatFolderSelection) {
	if (
		selection !== 'all' &&
		selection !== 'dms' &&
		selection !== 'groups' &&
		!chatGroupFoldersStore.folders.some(
			(folder) => `${FOLDER_KEY_PREFIX}${folder.id}` === selection
		)
	) {
		return;
	}
	chatGroupFoldersStore.selected = selection;
}

/** The folder a `folder:` selection points at, if it still exists. */
export function getSelectedChatGroupFolder(): ChatGroupFolder | undefined {
	const selected = chatGroupFoldersStore.selected;
	if (!selected.startsWith(FOLDER_KEY_PREFIX)) return undefined;
	const folderId = selected.slice(FOLDER_KEY_PREFIX.length);
	return chatGroupFoldersStore.folders.find((folder) => folder.id === folderId);
}

/** Pure match rule so tests never need the group store: DM = exactly two
 *  members (the roster includes me), custom folders match stored membership. */
export function chatFolderSelectionMatches(
	selection: ChatFolderSelection,
	memberCount: number,
	groupId: string
): boolean {
	if (selection === 'all') return true;
	if (selection === 'dms') return memberCount === 2;
	if (selection === 'groups') return memberCount !== 2;
	const folderId = selection.slice(FOLDER_KEY_PREFIX.length);
	return chatGroupFoldersStore.folders.some(
		(folder) => folder.id === folderId && folder.groupIds.includes(groupId)
	);
}

export function chatFolderMatchesGroup(
	selection: ChatFolderSelection,
	group: StoredChatGroup
): boolean {
	return chatFolderSelectionMatches(selection, listChatGroupMembers(group.id).length, group.id);
}
