import { describe, expect, test } from 'vitest';
import { nip19 } from 'nostr-tools';

import {
	getHighlightContext,
	getHighlightSources,
	parseHighlightAddress,
	splitHighlightContext
} from './highlights';

const ARTICLE_ADDRESS =
	'30023:bb1ba8fae639bbb64e0a27e19e6e0145e88d9a7db03bcf484a19372e26f8721e:v2idea';

describe('highlight parsing', () => {
	test('parses an address tag with an optional relay hint', () => {
		expect(parseHighlightAddress(ARTICLE_ADDRESS, 'wss://relay.damus.io')).toEqual({
			kind: 30023,
			pubkey: 'bb1ba8fae639bbb64e0a27e19e6e0145e88d9a7db03bcf484a19372e26f8721e',
			identifier: 'v2idea',
			relays: ['wss://relay.damus.io']
		});
		expect(parseHighlightAddress(ARTICLE_ADDRESS, 'https://example.com')).toEqual({
			kind: 30023,
			pubkey: 'bb1ba8fae639bbb64e0a27e19e6e0145e88d9a7db03bcf484a19372e26f8721e',
			identifier: 'v2idea'
		});
		expect(parseHighlightAddress('not-an-address')).toBeNull();
		expect(parseHighlightAddress('30023::missing-pubkey')).toBeNull();
	});

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
