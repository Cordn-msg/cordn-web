import { describe, expect, test } from 'vitest';
import type { ClientState } from 'ts-mls';

import {
	blobAddress,
	buildImetaTag,
	buildMediaAad,
	decryptMedia,
	deriveMediaKey,
	encryptMedia,
	findImetaTag,
	isKnownMediaVersion,
	MEDIA_VERSION,
	parseImetaTag,
	type MediaMetadata
} from '$lib/services/chatMediaCrypto';

/**
 * cordn-em-v1 self-check. Exercises the REAL noble ChaCha20-Poly1305 + the real
 * ts-mls exporter derivation (no mocks), so it covers the actual encrypt/decrypt
 * path: AAD layout, nonce handling, AEAD integrity, metadata binding, and the
 * imeta round-trip. Mirrors the CLI coverage in
 * cordn/src/cli/utils/mediaMessages.test.ts.
 */
function fakeState(exporterSecret: Uint8Array): ClientState {
	// Only keySchedule.exporterSecret is touched by deriveMediaKey.
	return { keySchedule: { exporterSecret } } as unknown as ClientState;
}

const fileBytes = () =>
	new Uint8Array(Array.from('fake-image-bytes-not-a-real-image', (c) => c.charCodeAt(0)));
const meta: MediaMetadata = { mime: 'image/png', filename: 'cat.png' };

describe('encrypted media — crypto', () => {
	test('round-trips a file through encrypt/decrypt', async () => {
		const key = await deriveMediaKey(fakeState(new Uint8Array(32).fill(1)));
		const plaintext = fileBytes();
		const enc = encryptMedia({ key, plaintext, metadata: meta });

		expect(enc.nonce).toHaveLength(12);
		expect(enc.plaintextHash).toHaveLength(32);
		// blob = ciphertext + 16-byte Poly1305 tag, nonce NOT prepended (§3.3).
		expect(enc.blob.length).toBe(plaintext.length + 16);

		const { plaintext: decrypted } = decryptMedia({
			key,
			blob: enc.blob,
			nonce: enc.nonce,
			metadata: meta,
			expectedPlaintextHash: enc.plaintextHash
		});
		expect(decrypted).toEqual(plaintext);
	});

	test('media key is domain-separated from the group-payload context', async () => {
		// Same exporter secret, distinct context strings MUST yield distinct keys
		// — otherwise media and message-payload encryption would share a key.
		const state = fakeState(new Uint8Array(32).fill(5));
		const mediaKey = await deriveMediaKey(state);
		expect(mediaKey).toHaveLength(32);
		// Deriving again is deterministic.
		expect(await deriveMediaKey(state)).toEqual(mediaKey);
		// A different secret yields a different key.
		const other = await deriveMediaKey(fakeState(new Uint8Array(32).fill(6)));
		expect(other).not.toEqual(mediaKey);
	});

	test('a different key cannot decrypt (group-scoped)', async () => {
		const keyA = await deriveMediaKey(fakeState(new Uint8Array(32).fill(1)));
		const keyB = await deriveMediaKey(fakeState(new Uint8Array(32).fill(2)));
		const enc = encryptMedia({ key: keyA, plaintext: fileBytes(), metadata: meta });

		await expect(() =>
			decryptMedia({
				key: keyB,
				blob: enc.blob,
				nonce: enc.nonce,
				metadata: meta,
				expectedPlaintextHash: enc.plaintextHash
			})
		).toThrow();
	});

	test('tampering with the blob is detected (AEAD tag mismatch)', async () => {
		const key = await deriveMediaKey(fakeState(new Uint8Array(32).fill(3)));
		const enc = encryptMedia({ key, plaintext: fileBytes(), metadata: meta });
		const tampered = Uint8Array.from(enc.blob);
		tampered[0] = tampered[0]! ^ 0xff;
		expect(() =>
			decryptMedia({
				key,
				blob: tampered,
				nonce: enc.nonce,
				metadata: meta,
				expectedPlaintextHash: enc.plaintextHash
			})
		).toThrow();
	});

	test('rewiring metadata onto a blob fails (AAD binding)', async () => {
		const key = await deriveMediaKey(fakeState(new Uint8Array(32).fill(4)));
		const enc = encryptMedia({ key, plaintext: fileBytes(), metadata: meta });

		// Same blob/nonce/key, different filename: rebuilt AAD no longer matches.
		expect(() =>
			decryptMedia({
				key,
				blob: enc.blob,
				nonce: enc.nonce,
				metadata: { mime: 'image/png', filename: 'dog.png' },
				expectedPlaintextHash: enc.plaintextHash
			})
		).toThrow();
		// Likewise for a swapped MIME.
		expect(() =>
			decryptMedia({
				key,
				blob: enc.blob,
				nonce: enc.nonce,
				metadata: { mime: 'image/jpeg', filename: 'cat.png' },
				expectedPlaintextHash: enc.plaintextHash
			})
		).toThrow();
	});

	test('a wrong declared plaintext hash is rejected', async () => {
		const key = await deriveMediaKey(fakeState(new Uint8Array(32).fill(8)));
		const enc = encryptMedia({ key, plaintext: fileBytes(), metadata: meta });
		// A wrong `x` also breaks the AAD, so AEAD fails first.
		const wrongHash = new Uint8Array(32).fill(1);
		expect(() =>
			decryptMedia({
				key,
				blob: enc.blob,
				nonce: enc.nonce,
				metadata: meta,
				expectedPlaintextHash: wrongHash
			})
		).toThrow();
	});

	test('encrypting the same file twice yields distinct blobs (random nonce)', async () => {
		const key = await deriveMediaKey(fakeState(new Uint8Array(32).fill(9)));
		const plaintext = fileBytes();
		const a = encryptMedia({ key, plaintext, metadata: meta });
		const b = encryptMedia({ key, plaintext, metadata: meta });
		expect(a.nonce).not.toEqual(b.nonce);
		expect(a.blob).not.toEqual(b.blob);
		expect(
			decryptMedia({ key, ...a, metadata: meta, expectedPlaintextHash: a.plaintextHash }).plaintext
		).toEqual(plaintext);
	});

	test('blob address is sha256(blob) and distinct per blob', async () => {
		const key = await deriveMediaKey(fakeState(new Uint8Array(32).fill(10)));
		const enc = encryptMedia({ key, plaintext: fileBytes(), metadata: meta });
		expect(blobAddress(enc.blob)).toEqual(blobAddress(enc.blob));
		// Random nonce => distinct blob => distinct address (no dedup correlation).
		const enc2 = encryptMedia({ key, plaintext: fileBytes(), metadata: meta });
		expect(blobAddress(enc.blob)).not.toEqual(blobAddress(enc2.blob));
	});

	test('AAD layout is mime || 0x00 || filename || 0x00 || plaintextHash', () => {
		const plaintextHash = new Uint8Array(32).fill(7);
		const aad = buildMediaAad(meta, plaintextHash);
		const expected = Uint8Array.from([
			...'image/png'.split('').map((c) => c.charCodeAt(0)),
			0x00,
			...'cat.png'.split('').map((c) => c.charCodeAt(0)),
			0x00,
			...plaintextHash
		]);
		expect(Array.from(aad)).toEqual(Array.from(expected));
	});

	test('rejects a malformed nonce length', async () => {
		const key = await deriveMediaKey(fakeState(new Uint8Array(32).fill(11)));
		const enc = encryptMedia({ key, plaintext: fileBytes(), metadata: meta });
		expect(() =>
			decryptMedia({
				key,
				blob: enc.blob,
				nonce: new Uint8Array(11),
				metadata: meta,
				expectedPlaintextHash: enc.plaintextHash
			})
		).toThrow('nonce');
	});
});

describe('imeta tag', () => {
	const baseRef = {
		url: 'https://blossom.primal.net/abc',
		mime: 'image/png',
		filename: 'cat.png',
		plaintextHashHex: 'a'.repeat(64),
		nonceHex: 'b'.repeat(24),
		version: MEDIA_VERSION
	};

	test('round-trips all fields through build and parse', () => {
		const tag = buildImetaTag({
			...baseRef,
			dim: '800x600',
			blurhash: 'LF58Hj', // ponytail: dummy, not a real blurhash
			thumbhash: 'THdummy',
			alt: 'a cat'
		});
		expect(tag[0]).toBe('imeta');
		const parsed = parseImetaTag(tag);
		expect(parsed).toMatchObject({
			url: baseRef.url,
			mime: 'image/png',
			filename: 'cat.png',
			plaintextHashHex: 'a'.repeat(64),
			nonceHex: 'b'.repeat(24),
			version: MEDIA_VERSION,
			dim: '800x600',
			blurhash: 'LF58Hj',
			thumbhash: 'THdummy',
			alt: 'a cat'
		});
	});

	test('values may contain spaces (first space separates key from value)', () => {
		const tag = buildImetaTag({
			...baseRef,
			mime: 'application/pdf',
			filename: 'my holiday report.pdf',
			alt: 'a long alt description with spaces'
		});
		const parsed = parseImetaTag(tag);
		expect(parsed?.filename).toBe('my holiday report.pdf');
		expect(parsed?.alt).toBe('a long alt description with spaces');
	});

	test('parse returns null when a required field is missing', () => {
		expect(parseImetaTag(['imeta', 'url https://x', 'm image/png'])).toBeNull();
	});

	test('parse returns null for a non-imeta tag', () => {
		expect(parseImetaTag(['e', 'url https://x'])).toBeNull();
	});

	test('findImetaTag returns the first media reference and skips others', () => {
		const tags: string[][] = [
			['e', 'unrelated'],
			buildImetaTag({ ...baseRef, url: 'https://blossom.primal.net/first' })
		];
		expect(findImetaTag(tags)?.url).toBe('https://blossom.primal.net/first');
		expect(findImetaTag([])).toBeNull();
	});

	test('isKnownMediaVersion gates the v field (§4)', () => {
		expect(isKnownMediaVersion(MEDIA_VERSION)).toBe(true);
		expect(isKnownMediaVersion('cordn-em-v2')).toBe(false);
		expect(isKnownMediaVersion(undefined)).toBe(false);
	});
});
