import { describe, expect, it } from 'vitest';
import { mediaExtFromMime, replaceFileExt, sniffMediaMime } from './mediaSniff';

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** ISOBMFF box: size(4) + 'ftyp' + brand(4) + padding to 12 bytes. */
const ftyp = (brand: string): Uint8Array =>
	new Uint8Array([0, 0, 0, 24, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0]);

describe('sniffMediaMime', () => {
	it('recognizes HEIC and HEIF brands', () => {
		expect(sniffMediaMime(ftyp('heic'), false)).toBe('image/heic');
		expect(sniffMediaMime(ftyp('heix'), false)).toBe('image/heic');
		expect(sniffMediaMime(ftyp('mif1'), false)).toBe('image/heif');
		expect(sniffMediaMime(ftyp('msf1'), false)).toBe('image/heif');
	});

	it('recognizes AVIF and plain formats', () => {
		expect(sniffMediaMime(ftyp('avif'), false)).toBe('image/avif');
		expect(
			sniffMediaMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), false)
		).toBe('image/jpeg');
		expect(sniffMediaMime(new Uint8Array(ascii('GIF89a      ')), false)).toBe('image/gif');
		expect(
			sniffMediaMime(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]), false)
		).toBe('image/webp');
	});

	it('disambiguates unnamed ISOBMFF brands with the picker signal', () => {
		expect(sniffMediaMime(ftyp('isom'), true)).toBe('video/mp4');
		expect(sniffMediaMime(ftyp('isom'), false)).toBeNull();
	});

	it('recognizes WebM and rejects short/garbage input', () => {
		expect(
			sniffMediaMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), true)
		).toBe('video/webm');
		expect(sniffMediaMime(new Uint8Array([0, 1, 2]), true)).toBeNull();
		expect(sniffMediaMime(new Uint8Array(12), false)).toBeNull();
	});
});

describe('mediaExtFromMime / replaceFileExt', () => {
	it('maps known mimes and falls back to bin', () => {
		expect(mediaExtFromMime('image/heic')).toBe('heic');
		expect(mediaExtFromMime('application/octet-stream')).toBe('bin');
	});

	it('swaps or appends the extension', () => {
		expect(replaceFileExt('IMG_1234.HEIC', 'jpg')).toBe('IMG_1234.jpg');
		expect(replaceFileExt('photo', 'jpg')).toBe('photo.jpg');
	});
});
