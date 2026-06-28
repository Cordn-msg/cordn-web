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

export type BackupWorkerRequest = EncryptRequest | DecryptRequest;

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

export interface ErrorResponse {
	ok: false;
	message: string;
}

export type BackupWorkerResponse = EncryptResponse | DecryptResponse | ErrorResponse;
