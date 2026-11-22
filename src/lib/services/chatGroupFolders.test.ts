import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const store = new Map<string, string>();
const localStorageStub = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key)
};

// The service imports chatGroups (member lookup), whose graph reads
// localStorage at module scope — stub before the import evaluates.
vi.stubGlobal('localStorage', localStorageStub);
const service = await import('./chatGroupFolders.svelte');
vi.unstubAllGlobals();

const {
	chatFolderSelectionMatches,
	createChatGroupFolder,
	deleteChatGroupFolder,
	deleteChatGroupFoldersForOwner,
	getChatFolderSelection,
	getSelectedChatGroupFolder,
	listChatGroupFolders,
	loadChatGroupFoldersForOwner,
	removeChatGroupFromFolders,
	selectChatFolder,
	toggleChatGroupFolderMembership,
	updateChatGroupFolder
} = service;

const owner = 'aa'.repeat(32);
const otherOwner = 'bb'.repeat(32);

describe('chatGroupFolders', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', localStorageStub);
		store.clear();
		loadChatGroupFoldersForOwner(owner);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('folders persist under the active owner key and reset selection on load', () => {
		const { folder } = createChatGroupFolder('Work', ['g1', 'g2'], true);
		expect(folder?.groupIds).toEqual(['g1', 'g2']);
		selectChatFolder(`folder:${folder!.id}`);
		expect(getChatFolderSelection()).toBe(`folder:${folder!.id}`);

		loadChatGroupFoldersForOwner(otherOwner);
		expect(listChatGroupFolders()).toEqual([]);
		expect(getChatFolderSelection()).toBe('all');

		loadChatGroupFoldersForOwner(owner);
		expect(listChatGroupFolders().map((entry) => entry.name)).toEqual(['Work']);
		expect(getChatFolderSelection()).toBe('all');
	});

	test('name validation: empty, reserved, duplicate; rename may keep its own name', () => {
		expect(createChatGroupFolder('   ').error).toBeTruthy();
		expect(createChatGroupFolder('all').error).toBeTruthy();
		expect(createChatGroupFolder('DMs').error).toBeTruthy();
		expect(createChatGroupFolder('Groups').error).toBeTruthy();
		createChatGroupFolder('Work');
		expect(createChatGroupFolder('work').error).toBeTruthy();

		const { folder } = createChatGroupFolder('Family');
		// Clash with the OTHER folder errors; own name (case-variant) is fine.
		expect(updateChatGroupFolder(folder!.id, 'work', []).error).toBeTruthy();
		expect(updateChatGroupFolder(folder!.id, 'family', ['g1']).error).toBeUndefined();
		expect(listChatGroupFolders().find((entry) => entry.id === folder!.id)?.groupIds).toEqual([
			'g1'
		]);
	});

	test('membership toggles and deletion cleans every folder', () => {
		const { folder } = createChatGroupFolder('Work', ['g1']);
		toggleChatGroupFolderMembership(folder!.id, 'g2');
		toggleChatGroupFolderMembership(folder!.id, 'g1');
		expect(listChatGroupFolders()[0].groupIds).toEqual(['g2']);

		createChatGroupFolder('Family', ['g1', 'g2']);
		removeChatGroupFromFolders('g2');
		expect(listChatGroupFolders().map((entry) => entry.groupIds)).toEqual([[], ['g1']]);
	});

	test('deleting the selected folder falls back to all; unknown selections are ignored', () => {
		const { folder } = createChatGroupFolder('Work', ['g1']);
		selectChatFolder(`folder:${folder!.id}`);
		deleteChatGroupFolder(folder!.id);
		expect(getChatFolderSelection()).toBe('all');
		expect(getSelectedChatGroupFolder()).toBeUndefined();

		selectChatFolder('folder:not-a-folder');
		expect(getChatFolderSelection()).toBe('all');
		selectChatFolder('dms');
		expect(getChatFolderSelection()).toBe('dms');
	});

	test('malformed persisted JSON degrades to no folders', () => {
		store.set(`cordn-chat-group-folders:${owner}`, '{"folders":');
		loadChatGroupFoldersForOwner(owner);
		expect(listChatGroupFolders()).toEqual([]);

		store.set(
			`cordn-chat-group-folders:${owner}`,
			JSON.stringify([{ id: 'f1', name: 'Work' }, { id: '', name: 'x' }, 42])
		);
		loadChatGroupFoldersForOwner(owner);
		expect(listChatGroupFolders()).toEqual([{ id: 'f1', name: 'Work', groupIds: [] }]);
	});

	test('deleteChatGroupFoldersForOwner clears storage and in-memory state', () => {
		createChatGroupFolder('Work', ['g1']);
		deleteChatGroupFoldersForOwner(owner);
		expect(store.has(`cordn-chat-group-folders:${owner}`)).toBe(false);
		expect(listChatGroupFolders()).toEqual([]);
		expect(getChatFolderSelection()).toBe('all');
	});

	test('matching rules: DM = exactly two members; custom folders by membership', () => {
		const { folder } = createChatGroupFolder('Work', ['g1']);

		expect(chatFolderSelectionMatches('all', 5, 'g9')).toBe(true);
		expect(chatFolderSelectionMatches('dms', 2, 'g9')).toBe(true);
		expect(chatFolderSelectionMatches('dms', 3, 'g9')).toBe(false);
		expect(chatFolderSelectionMatches('dms', 1, 'g9')).toBe(false);
		expect(chatFolderSelectionMatches('groups', 3, 'g9')).toBe(true);
		expect(chatFolderSelectionMatches('groups', 2, 'g9')).toBe(false);

		expect(chatFolderSelectionMatches(`folder:${folder!.id}`, 3, 'g1')).toBe(true);
		expect(chatFolderSelectionMatches(`folder:${folder!.id}`, 3, 'g2')).toBe(false);
		expect(chatFolderSelectionMatches('folder:unknown', 3, 'g1')).toBe(false);
	});
});
