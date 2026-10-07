import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	normalizeGifQuery,
	isGifsMediaUrl,
	searchGifs,
	GifRateLimitedError,
	GifSearchUnavailableError
} from '$lib/queries/gifSearch';

describe('normalizeGifQuery', () => {
	it('trims and caps at 100 characters', () => {
		expect(normalizeGifQuery('  hello world  ')).toBe('hello world');
		expect(normalizeGifQuery('x'.repeat(150))).toBe('x'.repeat(100));
	});

	it('returns null for blank input', () => {
		expect(normalizeGifQuery('')).toBeNull();
		expect(normalizeGifQuery('   ')).toBeNull();
	});

	it('returns null for a lone Latin letter (rate-budget noise)', () => {
		expect(normalizeGifQuery('a')).toBeNull();
		expect(normalizeGifQuery(' Q ')).toBeNull();
	});

	it('keeps a lone emoji or CJK character (valid searches)', () => {
		expect(normalizeGifQuery('😂')).toBe('😂');
		expect(normalizeGifQuery('猫')).toBe('猫');
	});
});

describe('isGifsMediaUrl', () => {
	it('accepts only https gifs.nostr.build URLs', () => {
		expect(isGifsMediaUrl('https://gifs.nostr.build/abc.gif')).toBe(true);
		expect(isGifsMediaUrl('https://evil.example.com/abc.gif')).toBe(false);
		expect(isGifsMediaUrl('http://gifs.nostr.build/abc.gif')).toBe(false);
		expect(isGifsMediaUrl('https://gifs.nostr.build.evil.com/abc.gif')).toBe(false);
	});
});

describe('searchGifs transport', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns typed items from the response body', async () => {
		const body = {
			items: [{ id: 'a.gif', url: 'https://gifs.nostr.build/a.gif', previews: {} }]
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
		);
		const items = await searchGifs('gm');
		expect(items[0]?.id).toBe('a.gif');
	});

	it('maps 429 to GifRateLimitedError', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 429 }))
		);
		await expect(searchGifs('gm')).rejects.toBeInstanceOf(GifRateLimitedError);
	});

	it('maps non-2xx and network failures to GifSearchUnavailableError', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 403 }))
		);
		await expect(searchGifs('gm')).rejects.toBeInstanceOf(GifSearchUnavailableError);

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('network error (this is how CORS/403 reach browser code)');
			})
		);
		await expect(searchGifs('gm')).rejects.toBeInstanceOf(GifSearchUnavailableError);
	});

	it('passes aborts through untouched', async () => {
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new DOMException('The operation was aborted.', 'AbortError');
			})
		);
		const rejection = await searchGifs('gm', controller.signal).then(
			() => {
				throw new Error('expected rejection');
			},
			(err: unknown) => err
		);
		expect(rejection).toBeInstanceOf(DOMException);
		expect((rejection as DOMException).name).toBe('AbortError');
	});
});
