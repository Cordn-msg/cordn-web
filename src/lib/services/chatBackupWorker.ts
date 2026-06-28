/// <reference lib="webworker" />
/**
 * Off-thread backup crypto. PBKDF2 (600k iters) + AES-GCM would freeze a
 * phone's UI for seconds on the main thread, so this worker owns key
 * derivation and the cipher; the main thread only serializes the document
 * and assembles the envelope.
 *
 * Crypto runs native via crypto.subtle (PBKDF2 + AES-GCM) when the context is
 * secure — OS-backed SHA-256 is ~10-30x faster on a phone than pure-JS, at the
 * same 600k iterations and identical brute-force strength. On http:// self-host
 * (no secure context) it falls back to @noble's pure-JS PBKDF2/AES-GCM, which
 * is why @noble is still bundled. Output is byte-identical across both paths
 * (both append the 16-byte GCM tag), so a backup encrypted one way decrypts
 * the other — no envelope migration.
 *
 * Uses crypto.getRandomValues (not crypto.subtle) for IV/salt so restore still
 * works on http:// self-host, matching the choice documented in
 * chatBackup.svelte.ts.
 *
 * `self as unknown as DedicatedWorkerGlobalScope` avoids the DOM-vs-WebWorker
 * `self` ambiguity that arises because the project's tsconfig lib is DOM-only.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64ToBytes, bytesToBase64, toBufferSource } from 'ts-mls';

import {
	KEY_BYTES,
	IV_BYTES,
	PBKDF2_HASH,
	PBKDF2_ITERATIONS,
	SALT_BYTES,
	type BackupWorkerRequest,
	type BackupWorkerResponse
} from './chatBackupCrypto';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// crypto.subtle is present only in secure contexts, and that is stable for the
// worker's lifetime, so take it when available and fall back to @noble on
// http://.
const SUBTLE_AVAILABLE = typeof crypto !== 'undefined' && crypto.subtle !== undefined;

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
	const pw = new TextEncoder().encode(passphrase);
	if (SUBTLE_AVAILABLE) {
		// TS 6 widens Uint8Array to Uint8Array<ArrayBufferLike>, but crypto.subtle
		// wants ArrayBuffer-backed BufferSource. toBufferSource (from ts-mls) is a
		// no-op when the buffer is already an ArrayBuffer, copy otherwise.
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
	return pbkdf2(sha256, pw, salt, { c: PBKDF2_ITERATIONS, dkLen: KEY_BYTES });
}

async function aesEncrypt(
	key: Uint8Array,
	iv: Uint8Array,
	plaintext: Uint8Array
): Promise<Uint8Array> {
	if (SUBTLE_AVAILABLE) {
		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			toBufferSource(key),
			{ name: 'AES-GCM' },
			false,
			['encrypt']
		);
		return new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: toBufferSource(iv) },
				cryptoKey,
				toBufferSource(plaintext)
			)
		);
	}
	return gcm(key, iv).encrypt(plaintext);
}

async function aesDecrypt(
	key: Uint8Array,
	iv: Uint8Array,
	ciphertext: Uint8Array
): Promise<Uint8Array> {
	if (SUBTLE_AVAILABLE) {
		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			toBufferSource(key),
			{ name: 'AES-GCM' },
			false,
			['decrypt']
		);
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: toBufferSource(iv) },
				cryptoKey,
				toBufferSource(ciphertext)
			)
		);
	}
	return gcm(key, iv).decrypt(ciphertext);
}

function randomBytes(len: number): Uint8Array {
	// getRandomValues works in non-secure contexts too (only crypto.subtle needs
	// HTTPS), so restore just works on http:// self-host.
	return crypto.getRandomValues(new Uint8Array(len));
}

scope.onmessage = async (event: MessageEvent<BackupWorkerRequest>) => {
	const req = event.data;
	try {
		let res: BackupWorkerResponse;
		if (req.op === 'encrypt') {
			const salt = randomBytes(SALT_BYTES);
			const iv = randomBytes(IV_BYTES);
			const key = await deriveKey(req.passphrase, salt);
			const ciphertext = await aesEncrypt(key, iv, new TextEncoder().encode(req.plaintext));
			res = {
				ok: true,
				salt: bytesToBase64(salt),
				iv: bytesToBase64(iv),
				ciphertext: bytesToBase64(ciphertext)
			};
		} else {
			const key = await deriveKey(req.passphrase, base64ToBytes(req.salt));
			// Both crypto.subtle.decrypt and @noble gcm.decrypt throw on GCM tag
			// mismatch (wrong passphrase / corruption); the catch below surfaces
			// it to the main thread, which maps it to the user-facing "wrong
			// passphrase" message.
			const plaintext = await aesDecrypt(key, base64ToBytes(req.iv), base64ToBytes(req.ciphertext));
			res = { ok: true, plaintext: new TextDecoder().decode(plaintext) };
		}
		scope.postMessage(res);
	} catch (error) {
		scope.postMessage({
			ok: false,
			message: error instanceof Error ? error.message : 'Backup crypto failed'
		});
	}
};
