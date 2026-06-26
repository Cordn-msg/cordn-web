import { describe, it, expect } from 'vitest';
import {
	encodeGroupShareMetadata,
	decodeGroupMetadataQueryParam,
	parseShareTarget,
	healShareQuery
} from '$lib/utils/groupShareLink';

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
