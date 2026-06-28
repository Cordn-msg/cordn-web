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
 * Cross-path interop self-check for backup crypto. chatBackupWorker.ts derives
 * the PBKDF2 key and runs AES-GCM through crypto.subtle when in a secure
 * context and through @noble otherwise. A backup encrypted on one path must
 * restore on the other — this test fails the moment that assumption breaks
 * (e.g. if @noble ever changed its GCM tag placement). It uses the REAL
 * constants from chatBackupCrypto, so a config change that breaks interop
 * (different hash, key len, iteration source) is caught too.
 *
 * Doesn't import the worker: its top-level `self`/`scope` setup is browser-only,
 * and the load-bearing claim is the algorithm interop, which lives in the libs
 * and constants, not in the worker's branch.
 */

const PASSPHRASE = 'correct horse battery staple';
const PLAINTEXT = new TextEncoder().encode(
	'cordn-web-backup interop probe — ünïcödé, 150kb-ish, 🚀'
);

describe('backup crypto: crypto.subtle <-> @noble interop', () => {
	test('PBKDF2 key is byte-identical across crypto.subtle and @noble', async () => {
		const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		const pw = new TextEncoder().encode(PASSPHRASE);

		const baseKey = await crypto.subtle.importKey('raw', toBufferSource(pw), 'PBKDF2', false, [
			'deriveBits'
		]);
		const subtleKey = new Uint8Array(
			await crypto.subtle.deriveBits(
				{
					name: 'PBKDF2',
					hash: PBKDF2_HASH,
					salt: toBufferSource(salt),
					iterations: PBKDF2_ITERATIONS
				},
				baseKey,
				KEY_BYTES * 8
			)
		);

		const nobleKey = pbkdf2(sha256, pw, salt, { c: PBKDF2_ITERATIONS, dkLen: KEY_BYTES });

		expect(bytesToBase64(subtleKey)).toEqual(bytesToBase64(nobleKey));
	});

	test('payload encrypted by @noble decrypts under crypto.subtle', async () => {
		const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

		const nobleCiphertext = gcm(key, iv).encrypt(PLAINTEXT);

		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			toBufferSource(key),
			{ name: 'AES-GCM' },
			false,
			['decrypt']
		);
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: toBufferSource(iv) },
			cryptoKey,
			toBufferSource(nobleCiphertext)
		);

		expect(new Uint8Array(decrypted)).toEqual(PLAINTEXT);
	});

	test('payload encrypted by crypto.subtle decrypts under @noble', async () => {
		const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			toBufferSource(key),
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

		const decrypted = gcm(key, iv).decrypt(subtleCiphertext);

		expect(decrypted).toEqual(PLAINTEXT);
		// Sanity: a wrong passphrase/key must fail under @noble too, so the
		// decrypt path surfaces "wrong passphrase" rather than silent garbage.
		const wrongKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES)).fill(0);
		expect(() => gcm(wrongKey, iv).decrypt(subtleCiphertext)).toThrow();
	});
});
