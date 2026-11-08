import { describe, expect, test } from 'vitest';
import { nip19 } from 'nostr-tools';

import { getHighlightContext, getHighlightSources, splitHighlightContext } from './highlights';

const ARTICLE_ADDRESS =
	'30023:bb1ba8fae639bbb64e0a27e19e6e0145e88d9a7db03bcf484a19372e26f8721e:v2idea';
const EVENT_ID = 'aa'.repeat(32);

describe('highlight parsing', () => {
	test('turns a/r tags into de-duplicated sources', () => {
		const sources = getHighlightSources([
			['a', ARTICLE_ADDRESS, 'wss://relay.damus.io'],
			['a', ARTICLE_ADDRESS],
			['r', 'https://example.com/post'],
			['r', 'https://example.com/post'],
			['r', 'wss://not-a-web-link.example'],
			['p', 'ignored']
		]);

		expect(sources).toHaveLength(3);
		expect(sources[0]).toMatchObject({
			type: 'nostr',
			label: 'Nostr article',
			href: `https://nostr.at/${nip19.naddrEncode({
				kind: 30023,
				pubkey: 'bb1ba8fae639bbb64e0a27e19e6e0145e88d9a7db03bcf484a19372e26f8721e',
				identifier: 'v2idea',
				relays: ['wss://relay.damus.io']
			})}`
		});
		expect(sources[1]).toEqual({
			type: 'link',
			label: 'example.com',
			href: 'https://example.com/post'
		});
		expect(sources[2]).toEqual({ type: 'text', label: 'wss://not-a-web-link.example' });
	});

	test('turns an e tag into a nostr.at event link, skipping non-hex ids', () => {
		const entity = nip19.neventEncode({ id: EVENT_ID });
		expect(
			getHighlightSources([
				['e', 'zzzz'],
				['e', EVENT_ID]
			])
		).toEqual([
			{
				type: 'nostr',
				label: 'Nostr event',
				href: `https://nostr.at/${entity}`,
				entity
			}
		]);
	});

	test('r tags with the mention attribute are comment mentions, not sources', () => {
		expect(getHighlightSources([['r', 'https://example.com', 'mention']])).toEqual([]);
	});

	test('i tags link out only when they are URLs', () => {
		expect(getHighlightSources([['i', 'isbn:9780123456789']])).toEqual([
			{ type: 'text', label: 'isbn:9780123456789' }
		]);
		expect(getHighlightSources([['i', 'https://pod.example.com/ep/42']])).toEqual([
			{ type: 'link', label: 'pod.example.com', href: 'https://pod.example.com/ep/42' }
		]);
	});

	test('reads and trims the context tag', () => {
		expect(getHighlightContext([['context', '  surrounding prose  ']])).toBe('surrounding prose');
		expect(getHighlightContext([['context', '   ']])).toBeUndefined();
		expect(getHighlightContext([])).toBeUndefined();
	});

	test('splits context around the highlighted text', () => {
		expect(
			splitHighlightContext(
				'Before the quote, the quote itself, and after the quote.',
				'the quote itself'
			)
		).toEqual({
			before: 'Before the quote, ',
			highlight: 'the quote itself',
			after: ', and after the quote.'
		});
		expect(splitHighlightContext('no overlap here', 'missing')).toBeNull();
		expect(splitHighlightContext(undefined, 'anything')).toBeNull();
	});
});
