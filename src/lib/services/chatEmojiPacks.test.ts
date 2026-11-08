import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const active = { pubkey: 'aa'.repeat(32) };
vi.mock('./accountManager.svelte', () => ({
	manager: { getActive: () => active }
}));

import {
	deleteEmojiPacksForOwner,
	emojiSourcesForContent,
	listEmojiPacks,
	loadEmojiPacksForOwner,
	removeEmojiPack
} from './chatEmojiPacks.svelte';

const owner = 'aa'.repeat(32);
const other = 'bb'.repeat(32);
const store = new Map<string, string>();
const localStorageStub = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key)
};

function pack(coordinate: string, title: string, rows: Array<[string, string]>) {
	return {
		coordinate,
		title,
		emoji: rows.map(([name, url]) => ({ name, url }))
	};
}

const cats = pack(`30030:${owner}:cats`, 'Cats', [
	['cat', 'https://cdn.example/cat.png'],
	['wave', 'https://cdn.example/wave.png']
]);
const moreCats = pack(`30030:${owner}:more`, 'More', [
	['cat', 'https://cdn.example/other-cat.png']
]);

describe('emoji packs', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', localStorageStub);
		store.clear();
		active.pubkey = owner;
		deleteEmojiPacksForOwner(owner);
		deleteEmojiPacksForOwner(other);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('loads per owner and resolves content names with the first pack winning', () => {
		store.set(`cordn-chat-emoji-packs:${owner}`, JSON.stringify([cats, moreCats]));
		loadEmojiPacksForOwner(owner);
		expect(listEmojiPacks().map((entry) => entry.title)).toEqual(['Cats', 'More']);
		expect(emojiSourcesForContent('hello :cat: and :wave:')).toEqual([
			{ name: 'cat', url: 'https://cdn.example/cat.png', coordinate: cats.coordinate },
			{ name: 'wave', url: 'https://cdn.example/wave.png', coordinate: cats.coordinate }
		]);

		active.pubkey = other;
		loadEmojiPacksForOwner(other);
		expect(listEmojiPacks()).toEqual([]);
	});

	test('removes one pack and deletes the owner key on logout', () => {
		store.set(`cordn-chat-emoji-packs:${owner}`, JSON.stringify([cats, moreCats]));
		loadEmojiPacksForOwner(owner);
		removeEmojiPack(cats.coordinate);
		expect(listEmojiPacks().map((entry) => entry.title)).toEqual(['More']);

		deleteEmojiPacksForOwner(owner);
		expect(listEmojiPacks()).toEqual([]);
		expect(store.has(`cordn-chat-emoji-packs:${owner}`)).toBe(false);
	});

	test('ignores corrupt or invalid stored rows', () => {
		store.set(
			`cordn-chat-emoji-packs:${owner}`,
			JSON.stringify([cats, { coordinate: 'nope', title: 'Bad', emoji: [] }])
		);
		loadEmojiPacksForOwner(owner);
		expect(listEmojiPacks().map((entry) => entry.title)).toEqual(['Cats']);

		store.set(`cordn-chat-emoji-packs:${owner}`, '{not json');
		active.pubkey = other;
		loadEmojiPacksForOwner(other);
		expect(listEmojiPacks()).toEqual([]);
		active.pubkey = owner;
		loadEmojiPacksForOwner(owner);
		expect(listEmojiPacks()).toEqual([]);
	});
});
