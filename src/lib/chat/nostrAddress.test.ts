import { describe, expect, test } from 'vitest';

import { parseNostrAddress } from './nostrAddress';

const ARTICLE_ADDRESS =
	'30023:bb1ba8fae639bbb64e0a27e19e6e0145e88d9a7db03bcf484a19372e26f8721e:v2idea';

describe('parseNostrAddress', () => {
	test('parses kind:pubkey:identifier with an optional relay hint', () => {
		expect(parseNostrAddress(ARTICLE_ADDRESS, 'wss://relay.damus.io')).toEqual({
			kind: 30023,
			pubkey: 'bb1ba8fae639bbb64e0a27e19e6e0145e88d9a7db03bcf484a19372e26f8721e',
			identifier: 'v2idea',
			relays: ['wss://relay.damus.io']
		});
		// Non-websocket hints are ignored, not attached.
		expect(parseNostrAddress(ARTICLE_ADDRESS, 'https://example.com')).toEqual({
			kind: 30023,
			pubkey: 'bb1ba8fae639bbb64e0a27e19e6e0145e88d9a7db03bcf484a19372e26f8721e',
			identifier: 'v2idea'
		});
	});

	test('rejects malformed coordinates', () => {
		expect(parseNostrAddress(undefined)).toBeNull();
		expect(parseNostrAddress('not-an-address')).toBeNull();
		expect(parseNostrAddress('30023::missing-pubkey')).toBeNull();
		expect(parseNostrAddress(':30023:oops')).toBeNull();
	});
});
