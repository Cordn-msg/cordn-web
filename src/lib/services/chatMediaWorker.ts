/// <reference lib="webworker" />
/**
 * Off-thread media decryption. ChaCha20-Poly1305 over a few hundred KB (images)
 * is fast but not free, and the receive path is bursty (scrolling a feed of
 * media) — running it here keeps the main thread / scroll jank-free.
 *
 * Mirrors `chatBackupWorker.ts`'s Vite module-worker pattern: the main thread
 * hands over the transferred ciphertext bytes (zero-copy), the worker decrypts
 * and returns the plaintext (transferred back). The cipher op is pure-JS @noble
 * (no `crypto.subtle` ChaCha20 exists), so unlike the backup worker there is no
 * native/subtle dual path here.
 *
 * Imports ONLY from `chatMediaCipher` (ts-mls- and DOM-free), so the MLS group
 * state, relay pool, and the rest of the app never cross the worker boundary.
 * `self as unknown as DedicatedWorkerGlobalScope` avoids the DOM-vs-WebWorker
 * `self` ambiguity under the project's DOM-only tsconfig lib.
 */
import { decryptMedia } from './chatMediaCipher';
import type { MediaDecryptRequest, MediaWorkerResponse } from './chatMediaCipher';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<MediaDecryptRequest>) => {
	const req = event.data;
	try {
		// decryptMedia rebuilds the AAD from the exact imeta bytes, verifies the
		// AEAD tag (noble throws on mismatch — tamper / wrong key / rewired
		// metadata), and confirms sha256(plaintext) == expectedHash.
		const { plaintext } = decryptMedia({
			key: req.key,
			blob: req.blob,
			nonce: req.nonce,
			metadata: { mime: req.mime, filename: req.filename },
			expectedPlaintextHash: req.expectedPlaintextHash
		});
		const res: MediaWorkerResponse = { ok: true, plaintext };
		scope.postMessage(res, [plaintext.buffer]);
	} catch (error) {
		const res: MediaWorkerResponse = {
			ok: false,
			message: error instanceof Error ? error.message : 'Media decrypt failed'
		};
		scope.postMessage(res);
	}
};
