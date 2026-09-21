import { describe, expect, test } from 'vitest';
import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64, toBufferSource } from 'ts-mls';

import {
	IV_BYTES,
	KEY_BYTES,
	PBKDF2_HASH,
	PBKDF2_ITERATIONS,
	SALT_BYTES
} from '$lib/services/chatBackupCrypto';

/**
 * Interop self-checks for the v2 (backup-key) worker ops, same approach as
 * chatBackupCrypto.test.ts: the worker runs crypto.subtle in secure contexts and
 * @noble otherwise, so anything encrypted on one path must decrypt on the other.
 * Covers the raw-key data path (encryptWithKey/decryptWithKey — no KDF) and the
 * passphrase key-wrapping path (wrapKey/unwrapKey — PBKDF2 KEK over the 32-byte BK).
 */

const PASSPHRASE = 'automation wrapper passphrase';
const PLAINTEXT = new TextEncoder().encode(
	'v2 backup-key interop probe — ünïcödé, 🚀, includes private keys'
);

async function subtleDeriveKey(pw: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
	const baseKey = await crypto.subtle.importKey('raw', toBufferSource(pw), 'PBKDF2', false, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			hash: PBKDF2_HASH,
			salt: toBufferSource(salt),
			iterations: PBKDF2_ITERATIONS
		},
		baseKey,
		KEY_BYTES * 8
	);
	return new Uint8Array(bits);
}

describe('backup v2 crypto: raw backup key (no KDF)', () => {
	test('payload encrypted by @noble decrypts under crypto.subtle and round-trips', async () => {
		const backupKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

		const nobleCiphertext = gcm(backupKey, iv).encrypt(PLAINTEXT);

		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			toBufferSource(backupKey),
			{ name: 'AES-GCM' },
			false,
			['decrypt']
		);
		const decrypted = new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: toBufferSource(iv) },
				cryptoKey,
				toBufferSource(nobleCiphertext)
			)
		);
		expect(decrypted).toEqual(PLAINTEXT);

		// And the wrong key must fail (tag mismatch), not return garbage.
		const wrongKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		await expect(
			crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: toBufferSource(iv) },
				await crypto.subtle.importKey('raw', toBufferSource(wrongKey), { name: 'AES-GCM' }, false, [
					'decrypt'
				]),
				toBufferSource(nobleCiphertext)
			)
		).rejects.toThrow();
	});

	test('payload encrypted by crypto.subtle decrypts under @noble', async () => {
		const backupKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			toBufferSource(backupKey),
			{ name: 'AES-GCM' },
			false,
			['encrypt']
		);
		const subtleCiphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: toBufferSource(iv) },
				cryptoKey,
				toBufferSource(PLAINTEXT)
			)
		);

		expect(gcm(backupKey, iv).decrypt(subtleCiphertext)).toEqual(PLAINTEXT);
	});
});

describe('backup v2 crypto: passphrase-wrapped backup key', () => {
	test('wrapped by @noble unwraps under crypto.subtle (and vice versa)', async () => {
		const backupKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const pw = new TextEncoder().encode(PASSPHRASE);

		// Wrap on the @noble path (KEK = PBKDF2, AES-GCM over the 32-byte BK).
		const nobleKek = pbkdf2(sha256, pw, salt, { c: PBKDF2_ITERATIONS, dkLen: KEY_BYTES });
		const wrapped = gcm(nobleKek, iv).encrypt(backupKey);

		// Unwrap on the crypto.subtle path.
		const subtleKek = await subtleDeriveKey(pw, salt);
		const unwrapKey = await crypto.subtle.importKey(
			'raw',
			toBufferSource(subtleKek),
			{ name: 'AES-GCM' },
			false,
			['decrypt']
		);
		const unwrapped = new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: toBufferSource(iv) },
				unwrapKey,
				toBufferSource(wrapped)
			)
		);
		expect(unwrapped).toEqual(backupKey);

		// And the reverse direction: subtle wraps, noble unwraps.
		const wrapKey = await crypto.subtle.importKey(
			'raw',
			toBufferSource(subtleKek),
			{ name: 'AES-GCM' },
			false,
			['encrypt']
		);
		const subtleWrapped = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: toBufferSource(iv) },
				wrapKey,
				toBufferSource(backupKey)
			)
		);
		expect(gcm(nobleKek, iv).decrypt(subtleWrapped)).toEqual(backupKey);
	});

	test('wrong passphrase fails the GCM tag, not silently', () => {
		const backupKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

		const kek = pbkdf2(sha256, new TextEncoder().encode(PASSPHRASE), salt, {
			c: PBKDF2_ITERATIONS,
			dkLen: KEY_BYTES
		});
		const wrapped = gcm(kek, iv).encrypt(backupKey);

		const wrongKek = pbkdf2(sha256, new TextEncoder().encode('wrong passphrase'), salt, {
			c: PBKDF2_ITERATIONS,
			dkLen: KEY_BYTES
		});
		expect(() => gcm(wrongKek, iv).decrypt(wrapped)).toThrow();
	});

	test('recovery-key base64/hex round-trip matches the raw backup key', async () => {
		// restoreLatestDeviceBackup converts the displayed hex recovery key back to the base64
		// worker key; this pins the codec equivalence the restore path depends on.
		const { bytesToHex, hexToBytes } = await import('applesauce-core/helpers');
		const backupKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const viaHex = hexToBytes(bytesToHex(backupKey));
		expect(bytesToBase64(viaHex)).toEqual(bytesToBase64(backupKey));
	});
});
