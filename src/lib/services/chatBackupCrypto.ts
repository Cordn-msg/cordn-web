/**
 * Crypto constants + worker message protocol shared between the main thread
 * (chatBackup.svelte.ts) and the backup worker (chatBackupWorker.ts).
 *
 * Deliberately has NO @noble imports: the main thread imports the constants and
 * protocol types from here, and that must NOT drag @noble's pure-JS crypto into
 * the main bundle. Only the worker imports @noble.
 */

// OWASP 2023 floor for PBKDF2-SHA256. @noble/hashes is sync pure-JS and runs
// entirely off-thread in the backup worker — ~0.3s on a desktop CPU but easily
// 2–10s on a phone, which is exactly why the work is in a worker. Do not raise
// without measuring mobile; lower only if you accept weaker brute-force
// resistance.
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_HASH = 'SHA-256';
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const KEY_BYTES = 32;

export interface EncryptRequest {
	op: 'encrypt';
	passphrase: string;
	/** Pre-serialized backup document (JSON.stringify of BackupDocument). */
	plaintext: string;
}

export interface DecryptRequest {
	op: 'decrypt';
	passphrase: string;
	salt: string;
	iv: string;
	ciphertext: string;
}

/** v2 envelope: encrypt the document with a raw 32-byte backup key (base64). No KDF — this is
 * the automated-backup hot path, so it must be instant even on a phone. */
export interface EncryptWithKeyRequest {
	op: 'encryptWithKey';
	/** Raw backup key, base64. */
	key: string;
	plaintext: string;
}

export interface DecryptWithKeyRequest {
	op: 'decryptWithKey';
	key: string;
	iv: string;
	ciphertext: string;
}

/** Wrap the raw backup key with a passphrase-derived key (PBKDF2 + AES-GCM on 32 bytes).
 * Runs once at enable/passphrase-change, never per backup — the KDF cost stays off the hot path. */
export interface WrapKeyRequest {
	op: 'wrapKey';
	passphrase: string;
	/** Raw backup key, base64. */
	key: string;
}

export interface UnwrapKeyRequest {
	op: 'unwrapKey';
	passphrase: string;
	salt: string;
	iv: string;
	/** Wrapped backup key, base64. */
	wrapped: string;
}

export type BackupWorkerRequest =
	| EncryptRequest
	| DecryptRequest
	| EncryptWithKeyRequest
	| DecryptWithKeyRequest
	| WrapKeyRequest
	| UnwrapKeyRequest;

export interface EncryptResponse {
	ok: true;
	salt: string;
	iv: string;
	ciphertext: string;
}

export interface DecryptResponse {
	ok: true;
	plaintext: string;
}

export interface EncryptWithKeyResponse {
	ok: true;
	iv: string;
	ciphertext: string;
}

export interface DecryptWithKeyResponse {
	ok: true;
	plaintext: string;
}

export interface WrapKeyResponse {
	ok: true;
	salt: string;
	iv: string;
	wrapped: string;
}

export interface UnwrapKeyResponse {
	ok: true;
	/** Raw backup key, base64. */
	key: string;
}

export interface ErrorResponse {
	ok: false;
	message: string;
}

export type BackupWorkerResponse =
	| EncryptResponse
	| DecryptResponse
	| EncryptWithKeyResponse
	| DecryptWithKeyResponse
	| WrapKeyResponse
	| UnwrapKeyResponse
	| ErrorResponse;
