import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';

import {
	EMOJI_MEDIA_TAG,
	dropStaleEmojiMediaTags,
	emojiByName,
	emojiMapFromTags,
	emojiPacksFromEvents,
	emojiPackNaddr,
	isEmojiOnlyText,
	matchEmojiShortcodes,
	nameOfWholeShortcode,
	parseEmojiMediaTag,
	parseEmojiSetAddress,
	parseEmojiSetEvent,
	shortcodeQueryAt
} from '$lib/chat/emoji';

const author = 'a'.repeat(64);

describe('emoji set addresses', () => {
	it('reads a coordinate, an naddr, a nostr URI and a link holding one', () => {
		const naddr = nip19.naddrEncode({
			kind: 30030,
			pubkey: author,
			identifier: 'cats',
			relays: ['wss://relay.example']
		});
		for (const input of [naddr, `nostr:${naddr}`, `https://njump.me/${naddr}`]) {
			const address = parseEmojiSetAddress(input);
			expect(address?.coordinate).toBe(`30030:${author}:cats`);
			expect(address?.relays).toEqual(['wss://relay.example']);
		}
		expect(parseEmojiSetAddress(`30030:${author.toUpperCase()}:cats`)?.pubkey).toBe(author);
	});

	it('keeps relay hints on a pack naddr and drops non-websocket hints', () => {
		const pack = {
			coordinate: `30030:${author}:cats`,
			title: 'Cats',
			emoji: [{ name: 'cat', url: 'https://cdn.example/cat.png' }],
			relays: ['wss://relay.example', 'https://not-a-relay.example']
		};
		const address = parseEmojiSetAddress(emojiPackNaddr(pack));
		expect(address?.coordinate).toBe(pack.coordinate);
		expect(address?.relays).toEqual(['wss://relay.example']);
	});

	it('refuses a non-set or malformed address', () => {
		expect(parseEmojiSetAddress('')).toBeNull();
		expect(parseEmojiSetAddress('cats')).toBeNull();
		expect(parseEmojiSetAddress(`10030:${author}:cats`)).toBeNull();
		const article = nip19.naddrEncode({ kind: 30023, pubkey: author, identifier: 'post' });
		expect(parseEmojiSetAddress(article)).toBeNull();
	});
});

describe('emoji sets', () => {
	it('lets the first pack win a duplicate shortcode', () => {
		const packs = [
			{
				coordinate: `30030:${author}:first`,
				title: 'First',
				emoji: [{ name: 'cat', url: 'https://cdn.example/first.png' }]
			},
			{
				coordinate: `30030:${author}:second`,
				title: 'Second',
				emoji: [{ name: 'cat', url: 'https://cdn.example/second.png' }]
			}
		];
		expect(emojiByName(packs).get('cat')?.url).toBe('https://cdn.example/first.png');
	});

	it('reads rows in order, skipping bad and duplicate ones', () => {
		const pack = parseEmojiSetEvent({
			kind: 30030,
			pubkey: author,
			tags: [
				['d', 'cats'],
				['title', 'Cats'],
				['emoji', 'cat', 'https://cdn.example/cat.png'],
				['emoji', 'bad name', 'https://cdn.example/no.png'],
				['emoji', 'cat', 'https://cdn.example/other.png'],
				['emoji', 'wave', 'https://cdn.example/wave.gif']
			]
		});
		expect(pack).toMatchObject({
			coordinate: `30030:${author}:cats`,
			title: 'Cats'
		});
		expect(pack?.emoji.map((emoji) => emoji.name)).toEqual(['cat', 'wave']);
		expect(pack?.emoji[0].url).toBe('https://cdn.example/cat.png');
	});

	it('dedupes relay copies by coordinate, keeping the newest set', () => {
		const event = (createdAt: number, title: string) => ({
			kind: 30030,
			pubkey: author,
			created_at: createdAt,
			tags: [
				['d', 'cats'],
				['title', title],
				['emoji', 'cat', 'https://cdn.example/cat.png']
			]
		});
		const packs = emojiPacksFromEvents([
			event(10, 'Old'),
			event(20, 'New'),
			{ ...event(30, 'Ignored'), kind: 1 }
		]);
		expect(packs).toHaveLength(1);
		expect(packs[0].title).toBe('New');
	});

	it('falls back to the d identifier and refuses an empty set', () => {
		expect(
			parseEmojiSetEvent({
				kind: 30030,
				pubkey: author,
				tags: [
					['d', 'cats'],
					['emoji', 'cat', 'https://cdn.example/cat.png']
				]
			})?.title
		).toBe('cats');
		expect(parseEmojiSetEvent({ kind: 30030, pubkey: author, tags: [['d', 'empty']] })).toBeNull();
		expect(parseEmojiSetEvent({ kind: 1, pubkey: author, tags: [] })).toBeNull();
	});
});

describe('emoji tags', () => {
	const mediaTag = (name: string, url = 'https://blossom.example/blob') => [
		EMOJI_MEDIA_TAG,
		`name ${name}`,
		`url ${url}`,
		'm image/png',
		`filename ${name}.png`,
		`x ${'a'.repeat(64)}`,
		`n ${'b'.repeat(24)}`,
		'v cordn-em-v1'
	];

	it('reads plain NIP-30 tags and prefers an encrypted picture for the same name', () => {
		const map = emojiMapFromTags([
			['emoji', 'cat', 'https://cdn.example/cat.png', `30030:${author}:cats`],
			mediaTag('cat'),
			mediaTag('dog')
		]);
		expect(map.get('cat')?.url).toBe('https://cdn.example/cat.png');
		expect(map.get('cat')?.media?.url).toBe('https://blossom.example/blob');
		expect(map.get('dog')?.media?.name).toBe('dog');
	});

	it('skips malformed media tags and keeps the plain fallback', () => {
		expect(
			parseEmojiMediaTag([EMOJI_MEDIA_TAG, 'name bad name', 'url https://x.example/a'])
		).toBeNull();
		const svg = mediaTag('cat');
		svg[3] = 'm image/svg+xml';
		expect(parseEmojiMediaTag(svg)).toBeNull();
		const map = emojiMapFromTags([
			['emoji', 'cat', 'https://cdn.example/cat.png'],
			[EMOJI_MEDIA_TAG, 'name cat', 'url https://blossom.example/blob']
		]);
		expect(map.get('cat')?.url).toBe('https://cdn.example/cat.png');
		expect(map.get('cat')?.media).toBeUndefined();
	});

	it('finds a composer token only at a word boundary', () => {
		expect(shortcodeQueryAt(':cat', 4)).toEqual({ start: 0, query: 'cat' });
		expect(shortcodeQueryAt('hi :ca', 6)).toEqual({ start: 3, query: 'ca' });
		expect(shortcodeQueryAt('hi\n:', 4)).toEqual({ start: 3, query: '' });
		expect(shortcodeQueryAt('hi:cat', 6)).toBeNull();
		expect(shortcodeQueryAt('10:30', 5)).toBeNull();
		expect(shortcodeQueryAt(':cat:', 5)).toBeNull();
	});

	it('drops only stale emoji-media tags', () => {
		const tags = [
			[EMOJI_MEDIA_TAG, 'name cat'],
			['p', author]
		];
		expect(dropStaleEmojiMediaTags(tags, 'prepared', 'prepared')).toBe(tags);
		expect(dropStaleEmojiMediaTags(tags, 'prepared', 'current')).toEqual([['p', author]]);
		expect(dropStaleEmojiMediaTags([['p', author]], 'prepared', 'current')).toEqual([
			['p', author]
		]);
	});

	it('matches shortcodes by boundary and leaves times and words alone', () => {
		expect(matchEmojiShortcodes(':cat: at 10:30:00, a:cat: but :wave:').map((m) => m.name)).toEqual(
			['cat', 'wave']
		);
		expect(matchEmojiShortcodes('é:cat: ok :cat:').map((m) => m.name)).toEqual(['cat']);
		expect(nameOfWholeShortcode(':cat:')).toBe('cat');
		expect(nameOfWholeShortcode('a :cat:')).toBeNull();
	});
});

describe('isEmojiOnlyText', () => {
	it('accepts emoji sequences, alone or with spacing', () => {
		for (const text of ['😂', '😂😂', ' ❤️ ', '👍🏽', '👨‍👩‍👧', '🇧🇷', '1️⃣', '#️⃣', '😭\n😭']) {
			expect(isEmojiOnlyText(text), text).toBe(true);
		}
	});

	it('rejects anything with other content', () => {
		for (const text of ['', '   ', 'hi', '😂 hi', '123', ':cat:', 'ok 👍']) {
			expect(isEmojiOnlyText(text), text).toBe(false);
		}
	});
});
