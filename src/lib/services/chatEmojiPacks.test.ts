import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const active = { pubkey: 'aa'.repeat(32) };
vi.mock('./accountManager.svelte', () => ({
	manager: { getActive: () => active }
}));

const { fetchQuery } = vi.hoisted(() => ({ fetchQuery: vi.fn() }));
vi.mock('$lib/query-client', () => ({ queryClient: { fetchQuery } }));
vi.mock('$lib/queries/chatEmojiQueries', () => ({
	emojiSetQueryOptions: (address: unknown) => ({ address })
}));

// The collection only needs to answer "which names does it own" for this file.
const collected: Array<{ name: string; url: string }> = [];
vi.mock('./chatEmojiCollection.svelte', async () => ({
	listEmojiCollection: () =>
		collected.map((item) => ({
			...item,
			id: item.name,
			mime: 'image/png',
			filename: item.name,
			bytes: new Uint8Array(),
			addedAt: 0
		}))
}));

import { MAX_EMOJI_PACKS } from '$lib/chat/emoji';
import {
	addEmojiPackSnapshot,
	deleteEmojiPacksForOwner,
	emojiSourcesForContent,
	fetchEmojiPacksFromList,
	importEmojiPacksFromList,
	listEmojiPacks,
	loadEmojiPacksForOwner,
	packEmojiByName,
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

function address(pubkey: string, identifier: string, relays: string[] = []) {
	return { pubkey, identifier, relays, coordinate: `30030:${pubkey}:${identifier}` };
}

describe('emoji packs', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', localStorageStub);
		fetchQuery.mockReset();
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
		expect(emojiSourcesForContent('see https://example.com/:cat: and :cat:')).toEqual([
			{ name: 'cat', url: 'https://cdn.example/cat.png', coordinate: cats.coordinate }
		]);
		expect(packEmojiByName().get('cat')?.url).toBe('https://cdn.example/cat.png');

		active.pubkey = other;
		loadEmojiPacksForOwner(other);
		expect(listEmojiPacks()).toEqual([]);
	});

	test('adds a fetched snapshot and keeps its relay hints', () => {
		const snapshot = { ...cats, relays: ['wss://relay.example'] };
		expect(addEmojiPackSnapshot(snapshot)).toEqual({ pack: snapshot });
		expect(listEmojiPacks()).toEqual([snapshot]);
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

	test('sends the collected picture when a pack has the same shortcode', () => {
		store.set(`cordn-chat-emoji-packs:${owner}`, JSON.stringify([cats]));
		loadEmojiPacksForOwner(owner);
		collected.push({ name: 'cat', url: 'blob:collected' });

		expect(packEmojiByName().get('cat')?.coordinate).toBe('collection');
		expect(emojiSourcesForContent(':cat:')).toEqual([
			{
				name: 'cat',
				url: 'blob:collected',
				coordinate: 'collection',
				bytes: new Uint8Array(),
				mime: 'image/png'
			}
		]);
		collected.length = 0;
	});

	test('resolves a published list through the shared set query, reporting misses', async () => {
		fetchQuery.mockImplementation(
			async ({ address: requested }: { address: { identifier: string } }) =>
				requested.identifier === 'cats' ? cats : null
		);
		const hints = ['wss://relay.damus.io/'];
		const result = await fetchEmojiPacksFromList(
			[address(owner, 'cats', hints), address(other, 'gone')],
			{ refresh: true }
		);
		expect(fetchQuery).toHaveBeenCalledTimes(2);
		expect(fetchQuery).toHaveBeenCalledWith(expect.objectContaining({ staleTime: 0 }));
		expect(result.packs).toEqual([{ ...cats, relays: hints }]);
		expect(result.missing).toBe(1);
	});

	test('imports each published pack once', async () => {
		fetchQuery.mockResolvedValue(cats);
		const first = await importEmojiPacksFromList([address(owner, 'cats')], owner);
		expect(first).toEqual({ packs: [cats], missing: 0, blocked: 0 });
		expect(listEmojiPacks().map((pack) => pack.coordinate)).toEqual([cats.coordinate]);

		const again = await importEmojiPacksFromList([address(owner, 'cats')], owner);
		expect(again.blocked).toBe(0);
		expect(listEmojiPacks()).toHaveLength(1);
	});

	test('writes nothing when another account became active while the list resolved', async () => {
		fetchQuery.mockImplementation(async () => {
			active.pubkey = other;
			return cats;
		});
		const result = await importEmojiPacksFromList([address(owner, 'cats')], owner);
		expect(result.blocked).toBe(1);

		// A write that ignored the guard would have landed on the new account.
		loadEmojiPacksForOwner(other);
		expect(listEmojiPacks()).toEqual([]);
		expect(store.has(`cordn-chat-emoji-packs:${other}`)).toBe(false);
	});

	test('bounds a list at the pack limit and counts an unreadable set as missing', async () => {
		fetchQuery.mockRejectedValue(new Error('relay down'));
		const many = Array.from({ length: MAX_EMOJI_PACKS + 4 }, (_, index) =>
			address(owner, `pack-${index}`)
		);
		const result = await fetchEmojiPacksFromList(many);
		expect(fetchQuery).toHaveBeenCalledTimes(MAX_EMOJI_PACKS);
		expect(result.packs).toEqual([]);
		expect(result.missing).toBe(MAX_EMOJI_PACKS);
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
