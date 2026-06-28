/// <reference lib="webworker" />
/**
 * Off-thread backup crypto. PBKDF2 (600k iters) + AES-GCM are pure-JS in
 * @noble, so on a phone they would freeze the UI for seconds if run on the
 * main thread. This worker owns the key derivation and the cipher; the main
 * thread only serializes the document and assembles the envelope.
 *
 * Uses crypto.getRandomValues (not crypto.subtle) so restore still works on
 * http:// self-host, matching the choice documented in chatBackup.svelte.ts.
 *
 * `self as unknown as DedicatedWorkerGlobalScope` avoids the DOM-vs-WebWorker
 * `self` ambiguity that arises because the project's tsconfig lib is DOM-only.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64ToBytes, bytesToBase64 } from 'ts-mls';

import {
	KEY_BYTES,
	IV_BYTES,
	PBKDF2_ITERATIONS,
	SALT_BYTES,
	type BackupWorkerRequest,
	type BackupWorkerResponse
} from './chatBackupCrypto';

const scope = self as unknown as DedicatedWorkerGlobalScope;

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
	return pbkdf2(sha256, new TextEncoder().encode(passphrase), salt, {
		c: PBKDF2_ITERATIONS,
		dkLen: KEY_BYTES
	});
}

function randomBytes(len: number): Uint8Array {
	// getRandomValues works in non-secure contexts too (only crypto.subtle needs
	// HTTPS), so restore just works on http:// self-host.
	return crypto.getRandomValues(new Uint8Array(len));
}

scope.onmessage = (event: MessageEvent<BackupWorkerRequest>) => {
	const req = event.data;
	try {
		let res: BackupWorkerResponse;
		if (req.op === 'encrypt') {
			const salt = randomBytes(SALT_BYTES);
			const iv = randomBytes(IV_BYTES);
			const key = deriveKey(req.passphrase, salt);
			const ciphertext = gcm(key, iv).encrypt(new TextEncoder().encode(req.plaintext));
			res = {
				ok: true,
				salt: bytesToBase64(salt),
				iv: bytesToBase64(iv),
				ciphertext: bytesToBase64(ciphertext)
			};
		} else {
			const key = deriveKey(req.passphrase, base64ToBytes(req.salt));
			// gcm.decrypt throws on GCM tag mismatch (wrong passphrase /
			// corruption); the catch below surfaces it to the main thread, which
			// maps it to the user-facing "wrong passphrase" message.
			const plaintext = gcm(key, base64ToBytes(req.iv)).decrypt(base64ToBytes(req.ciphertext));
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
