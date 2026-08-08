import { describe, it, expect } from 'vitest';
import {
	encodeGroupShareMetadata,
	decodeGroupMetadataQueryParam,
	parseShareTarget,
	healShareQuery,
	buildGroupSharePath,
	resolveGroupLocator
} from '$lib/utils/groupShareLink';
import { encodeGroupRef } from '@cordn/core';

const COORD = '92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5';

describe('groupShareLink metadata codec', () => {
	it('round-trips name + icon through base64url', () => {
		const encoded = encodeGroupShareMetadata({ name: 'Cordn 🚀', icon: '💬' });
		if (!encoded) throw new Error('expected an encoded value');
		// ponytail: base64url must never carry +, /, or = — those are what chat
		// clients and email line-wrappers mangle.
		expect(encoded).not.toMatch(/[+/=]/);
		expect(decodeGroupMetadataQueryParam(encoded)).toEqual({ name: 'Cordn 🚀', icon: '💬' });
	});

	it('still decodes legacy standard-base64 links (+/=) for back-compat', () => {
		// Equivalent of { name: 'Legacy' } under standard base64 (with +,/,=).
		const legacy = btoa(
			String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ name: 'Legacy' })))
		);
		expect(legacy).toMatch(/[+/=]/);
		expect(decodeGroupMetadataQueryParam(legacy)).toEqual({ name: 'Legacy' });
	});

	it('returns null for empty name', () => {
		expect(encodeGroupShareMetadata({ name: '' })).toBeNull();
	});
});

describe('parseShareTarget', () => {
	it('routes bare ids to /chat/<id> on the default coordinator', () => {
		const t = parseShareTarget('abc-123');
		if (!t || t.kind !== 'internal') throw new Error('expected internal');
		expect(t.path).toBe('/chat/abc-123');
	});

	it('treats a leading-slash path as internal', () => {
		const t = parseShareTarget('/chat/abc?c=nprofile1xyz&m=bmFtZQ');
		if (!t || t.kind !== 'internal') throw new Error('expected internal');
		expect(t.path).toBe('/chat/abc?c=nprofile1xyz&m=bmFtZQ');
	});

	it('classifies absolute http(s) URLs as external', () => {
		const t = parseShareTarget('https://cordn.example/chat/abc');
		if (!t || t.kind !== 'external') throw new Error('expected external');
		expect(t.url).toBe('https://cordn.example/chat/abc');
	});

	it('rejects empty input', () => {
		expect(parseShareTarget('   ')).toBeNull();
	});
});

describe('healShareQuery', () => {
	it('drops a malformed m= but keeps a valid c=', () => {
		// c= is bech32 (URL-safe); m= here is garbage that fails base64url/JSON decode.
		const healed = healShareQuery('/chat/abc?c=nprofile1qpzry&m=!!!not-base64!!!');
		expect(healed).toBe('/chat/abc?c=nprofile1qpzry');
	});

	it('keeps a valid m=', () => {
		const valid = encodeGroupShareMetadata({ name: 'Keep me' });
		if (!valid) throw new Error('expected encoded metadata');
		const path = `/chat/abc?m=${valid}`;
		expect(healShareQuery(path)).toBe(path);
	});

	it('leaves paths without a query untouched', () => {
		expect(healShareQuery('/chat/abc')).toBe('/chat/abc');
	});

	it('preserves a hash when present', () => {
		const healed = healShareQuery('/chat/abc?m=garbage#msg-1');
		expect(healed).toBe('/chat/abc#msg-1');
	});
});

describe('buildGroupSharePath + resolveGroupLocator (cordn1)', () => {
	it('packs gid + coordinator + relays into /chat/cordn1… and decodes back', () => {
		const path = buildGroupSharePath({
			groupId: 'group-42',
			coordinatorKey: COORD,
			relays: ['wss://relay.example'],
			metadata: { name: 'Cordn 🚀', icon: '💬' }
		});
		// Path-based; coordinator is embedded in the cordn1 ref (no ?c=); name in ?m=.
		expect(path.startsWith('/chat/cordn1')).toBe(true);
		expect(path).not.toContain('c=');
		expect(path).toContain('m=');

		const code = path.slice('/chat/'.length, path.indexOf('?'));
		const locator = resolveGroupLocator(code, new URLSearchParams(path.slice(path.indexOf('?'))));
		expect(locator.gid).toBe('group-42');
		expect(locator.coordinatorKey).toBe(COORD);
		expect(locator.relays).toEqual(['wss://relay.example']);
		expect(locator.coordinatorProvided).toBe(true);
		expect(locator.coordinatorError).toBe('');
		expect(locator.shareMetadata).toEqual({ name: 'Cordn 🚀', icon: '💬' });
	});

	it('always includes the coordinator (even for a default-coordinator group)', () => {
		const path = buildGroupSharePath({ groupId: 'g', coordinatorKey: COORD });
		const code = path.slice('/chat/'.length);
		const locator = resolveGroupLocator(code, new URLSearchParams());
		expect(locator.gid).toBe('g');
		expect(locator.coordinatorKey).toBe(COORD);
		expect(locator.coordinatorProvided).toBe(true);
	});
});

describe('resolveGroupLocator', () => {
	it('defaults the coordinator when a cordn1 ref omits type 1', () => {
		const code = encodeGroupRef({ gid: 'only-gid' });
		const locator = resolveGroupLocator(code, new URLSearchParams());
		expect(locator.gid).toBe('only-gid');
		expect(locator.coordinatorProvided).toBe(false);
		expect(locator.coordinatorKey).toMatch(/^[0-9a-f]{64}$/);
		expect(locator.coordinatorError).toBe('');
	});

	it('back-compat: bare gid + legacy ?c= hex coordinator', () => {
		const params = new URLSearchParams();
		params.set('c', COORD);
		const locator = resolveGroupLocator('bare-gid-1', params);
		expect(locator.gid).toBe('bare-gid-1');
		expect(locator.coordinatorKey).toBe(COORD);
		expect(locator.coordinatorProvided).toBe(true);
	});

	it('back-compat: bare gid with no ?c= uses the default coordinator', () => {
		const locator = resolveGroupLocator('bare-gid-2', new URLSearchParams());
		expect(locator.gid).toBe('bare-gid-2');
		expect(locator.coordinatorProvided).toBe(false);
		expect(locator.coordinatorKey).toMatch(/^[0-9a-f]{64}$/);
	});

	it('rejects a checksum-bad cordn1 without falling back to bare gid', () => {
		// Looks like a ref (prefix + lowercase tail) but fails the checksum.
		const locator = resolveGroupLocator('cordn1garbage', new URLSearchParams());
		expect(locator.gid).toBe('');
		expect(locator.coordinatorKey).toBe('');
		expect(locator.coordinatorProvided).toBe(false);
		expect(locator.coordinatorError).toBeTruthy();
	});
});

describe('parseShareTarget cordn1 + bare host', () => {
	it('routes a bare cordn1 ref to /chat/<ref> internally', () => {
		const code = encodeGroupRef({ gid: 'x', coordinatorPubkey: COORD });
		const t = parseShareTarget(code);
		if (!t || t.kind !== 'internal') throw new Error('expected internal');
		expect(t.path).toBe(`/chat/${code}`);
	});

	it('routes a bare cordn.net/… host URL internally (no scheme, query kept)', () => {
		const t = parseShareTarget('cordn.net/chat/some-id?m=abc');
		if (!t || t.kind !== 'internal') throw new Error('expected internal');
		expect(t.path).toBe('/chat/some-id?m=abc');
	});

	it('splits a trailing ?m=… query off a bare cordn1 ref (not into the id)', () => {
		// Regression: pasting a full share link's text (ref + metadata query)
		// must not %-encode the `?m=` into the gid segment.
		const code = encodeGroupRef({ gid: 'x', coordinatorPubkey: COORD });
		const t = parseShareTarget(`${code}?m=eyJuYW1lIjoiQyJ9`);
		if (!t || t.kind !== 'internal') throw new Error('expected internal');
		expect(t.path).toBe(`/chat/${code}?m=eyJuYW1lIjoiQyJ9`);
		expect(t.path).not.toMatch(/%3[FD]/);
	});
});
