import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes } from '@noble/ciphers/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Encrypted media (`cordn-em-v1`), pure cipher layer — see
 * `spec/applications/encrypted-media.md`.
 *
 * This module is deliberately ts-mls- and DOM-free: it holds only the AEAD
 * primitives, the AAD/imeta codec, and the worker message protocol. The
 * dedicated media worker imports `decryptMedia` from HERE (not from
 * `chatMediaCrypto.ts`), so its bundle never pulls the MLS group state, the
 * relay pool, or any other main-thread-only code across the worker boundary.
 * `deriveMediaKey` (the one function that needs the MLS exporter) lives in
 * `chatMediaCrypto.ts`, which re-exports everything below for main-thread
 * callers.
 */

const encoder = new TextEncoder();

/** spec/applications/encrypted-media.md §3.3 — nonce length. */
const NONCE_BYTES = 12;
export const MEDIA_VERSION = 'cordn-em-v1' as const;

export interface MediaMetadata {
	/** MIME type. Exact UTF-8 bytes are bound into the AAD (§3.2). */
	readonly mime: string;
	/** Original filename. Exact UTF-8 bytes are bound into the AAD (§3.2). */
	readonly filename: string;
}

export interface EncryptedMedia {
	/** AEAD ciphertext plus the 16-byte Poly1305 tag. Nonce is NOT prepended. */
	readonly blob: Uint8Array;
	/** Fresh random 12-byte nonce; carried in the `imeta` `n` field (§3.3). */
	readonly nonce: Uint8Array;
	/** SHA-256 of the original plaintext; carried in the `imeta` `x` field. */
	readonly plaintextHash: Uint8Array;
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
	return sha256(data);
}

/** Content-store address: SHA-256 of the encrypted blob (ciphertext + tag) (§6). */
export function blobAddress(blob: Uint8Array): Uint8Array {
	return sha256Bytes(blob);
}

/**
 * AAD = utf8(mime) || 0x00 || utf8(filename) || 0x00 || sha256(plaintext) (§3.2).
 * Exported so tests assert the exact byte layout; receivers must rebuild it
 * from the exact `m`/`filename`/`x` bytes carried in `imeta` (no normalization).
 */
export function buildMediaAad(metadata: MediaMetadata, plaintextHash: Uint8Array): Uint8Array {
	return concatBytes(
		encoder.encode(metadata.mime),
		new Uint8Array([0x00]),
		encoder.encode(metadata.filename),
		new Uint8Array([0x00]),
		plaintextHash
	);
}

/** ponytail: plain loop compare. This check runs only AFTER AEAD verification
 *  has already authenticated the plaintext (noble throws on tag mismatch), so
 *  it is belt-and-suspenders against a same-key/different-plaintext collision,
 *  not a timing-attack surface. The attacker cannot trigger it without first
 *  passing AEAD. */
function plaintextHashMatches(actual: Uint8Array, expected: Uint8Array): boolean {
	if (actual.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
	return diff === 0;
}

/**
 * Encrypt a media file under an already-derived `key` (§7 sending flow, steps
 * 1-5). Generates a fresh 12-byte nonce and returns blob/nonce/hash so the
 * caller can build the `imeta` and upload. Pure: no DOM, no MLS state.
 */
export function encryptMedia(params: {
	key: Uint8Array;
	plaintext: Uint8Array;
	metadata: MediaMetadata;
}): EncryptedMedia {
	const plaintextHash = sha256Bytes(params.plaintext);
	const nonce = randomBytes(NONCE_BYTES);
	const aad = buildMediaAad(params.metadata, plaintextHash);
	const blob = chacha20poly1305(params.key, nonce, aad).encrypt(params.plaintext);
	return { blob, nonce, plaintextHash };
}

/**
 * Decrypt an encrypted-media blob under an already-derived `key` (§7 receiving
 * flow, steps 4-6). Rebuilds the AAD from the exact imeta bytes, verifies the
 * AEAD tag, and confirms sha256(plaintext) == `expectedPlaintextHash`. Pure and
 * worker-safe: the worker imports this directly with a transferred key+blob.
 *
 * Throws on AEAD tag mismatch (tamper / wrong key / rewired metadata) — noble
 * raises there — and on a plaintext-hash mismatch (defense in depth).
 */
export function decryptMedia(params: {
	key: Uint8Array;
	blob: Uint8Array;
	nonce: Uint8Array;
	metadata: MediaMetadata;
	/** The `x` value from `imeta`: SHA-256 of the expected plaintext. */
	expectedPlaintextHash: Uint8Array;
}): { plaintext: Uint8Array } {
	if (params.nonce.length !== NONCE_BYTES) {
		throw new Error(`Invalid media nonce: expected ${NONCE_BYTES} bytes`);
	}
	if (params.expectedPlaintextHash.length !== 32) {
		throw new Error('Invalid media plaintext hash: expected 32 bytes');
	}
	const aad = buildMediaAad(params.metadata, params.expectedPlaintextHash);
	const plaintext = chacha20poly1305(params.key, params.nonce, aad).decrypt(params.blob);
	const actualHash = sha256Bytes(plaintext);
	if (!plaintextHashMatches(actualHash, params.expectedPlaintextHash)) {
		throw new Error('Encrypted media integrity check failed (plaintext hash mismatch)');
	}
	return { plaintext };
}

// ---------------------------------------------------------------------------
// NIP-92 `imeta` tag (the transport for an encrypted-media reference, §5)
// ---------------------------------------------------------------------------

export interface MediaReference {
	readonly url: string;
	readonly mime: string;
	readonly filename: string;
	/** `x`: lowercase hex SHA-256 of the original plaintext. */
	readonly plaintextHashHex: string;
	/** `n`: lowercase hex of the 12-byte nonce (24 chars). */
	readonly nonceHex: string;
	/** `v`: encryption version; `cordn-em-v1`. */
	readonly version: string;
	/** Display hints (§5) — passed through, not part of integrity. */
	readonly dim?: string;
	readonly blurhash?: string;
	readonly thumbhash?: string;
	readonly alt?: string;
}

/** Encodes a media reference as a NIP-92 `imeta` tag (`["imeta", "url ...", …]`). */
export function buildImetaTag(ref: MediaReference): string[] {
	const tag = [
		'imeta',
		`url ${ref.url}`,
		`m ${ref.mime}`,
		`filename ${ref.filename}`,
		`x ${ref.plaintextHashHex}`,
		`n ${ref.nonceHex}`,
		`v ${ref.version}`
	];
	if (ref.dim) tag.push(`dim ${ref.dim}`);
	if (ref.blurhash) tag.push(`blurhash ${ref.blurhash}`);
	if (ref.thumbhash) tag.push(`thumbhash ${ref.thumbhash}`);
	if (ref.alt) tag.push(`alt ${ref.alt}`);
	return tag;
}

/**
 * Parse a single `imeta` tag. Returns `null` if it is not `imeta` or is missing
 * a required field. The first space in each entry separates key from value, so
 * values (filename, alt) may themselves contain spaces (§5).
 */
export function parseImetaTag(tag: string[]): MediaReference | null {
	if (tag[0] !== 'imeta') return null;
	const fields: Record<string, string> = {};
	for (let i = 1; i < tag.length; i++) {
		const entry = tag[i] ?? '';
		const sep = entry.indexOf(' ');
		if (sep <= 0) continue;
		fields[entry.slice(0, sep)] = entry.slice(sep + 1);
	}
	const url = fields['url'];
	const mime = fields['m'];
	const filename = fields['filename'];
	const plaintextHashHex = fields['x'];
	const nonceHex = fields['n'];
	const version = fields['v'];
	if (!url || !mime || !filename || !plaintextHashHex || !nonceHex || !version) {
		return null;
	}
	return {
		url,
		mime,
		filename,
		plaintextHashHex,
		nonceHex,
		version,
		dim: fields['dim'],
		blurhash: fields['blurhash'],
		thumbhash: fields['thumbhash'],
		alt: fields['alt']
	};
}

/** First parseable `imeta` media reference in a tag list, or `null`. */
export function findImetaTag(tags: string[][]): MediaReference | null {
	for (const tag of tags) {
		if (tag[0] !== 'imeta') continue;
		const parsed = parseImetaTag(tag);
		if (parsed) return parsed;
	}
	return null;
}

/** §4: receivers MUST reject `imeta` whose `v` is absent or names an unknown version. */
export function isKnownMediaVersion(version: string | undefined): boolean {
	return version === MEDIA_VERSION;
}

// ---------------------------------------------------------------------------
// Worker message protocol — `import type` only on the worker side, so sharing
// these here never pulls this module (or its noble deps) into the worker at
// runtime; the worker's sole runtime import is `decryptMedia`.
// ---------------------------------------------------------------------------

export interface MediaDecryptRequest {
	key: Uint8Array;
	nonce: Uint8Array;
	/** AEAD ciphertext + 16-byte tag. Transferred (zero-copy) to the worker. */
	blob: Uint8Array;
	mime: string;
	filename: string;
	expectedPlaintextHash: Uint8Array;
}

export interface MediaDecryptResponse {
	ok: true;
	/** Decrypted plaintext. Transferred (zero-copy) back to the main thread. */
	plaintext: Uint8Array;
}

export interface MediaDecryptError {
	ok: false;
	message: string;
}

export type MediaWorkerResponse = MediaDecryptResponse | MediaDecryptError;
