/**
 * Client data backup / restore.
 *
 * The backup is a dumb object serializer: it snapshots the in-memory group
 * objects (which carry MLS ClientState secrets), the active account's private
 * keys, and the coordinator list (needed for relay resolution). It does not
 * model sync, decryptability, or MLS — those concerns live inside the group
 * object, so whatever fields exist on the group ride along.
 *
 * Key packages, welcome/join notifications, presence, and sent-join-requests
 * are intentionally excluded: all regenerable (key packages via coordinator
 * reconcile, the rest re-fetched on re-stream).
 *
 * Security: the document carries nsec private keys and group secrets, so the
 * passphrase-encrypted envelope (PBKDF2 + AES-GCM) is the default. The crypto
 * runs off-thread in chatBackupWorker.ts: @noble/hashes + @noble/ciphers are
 * pure-JS, so on a phone the 600k-iteration PBKDF2 would otherwise freeze the
 * UI for seconds. @noble is used instead of WebCrypto specifically because it
 * works on http:// self-host (crypto.subtle needs a secure context).
 * Unencrypted export/import is exposed as an explicit opt-in for dev/inspection.
 */
import { browser } from '$app/environment';
import type { SerializedAccount } from 'applesauce-accounts';
import {
	PBKDF2_HASH,
	PBKDF2_ITERATIONS,
	type BackupWorkerRequest,
	type BackupWorkerResponse,
	type DecryptRequest,
	type DecryptResponse,
	type DecryptWithKeyRequest,
	type DecryptWithKeyResponse,
	type EncryptRequest,
	type EncryptResponse,
	type EncryptWithKeyRequest,
	type EncryptWithKeyResponse,
	type ErrorResponse,
	type UnwrapKeyRequest,
	type UnwrapKeyResponse,
	type WrapKeyRequest,
	type WrapKeyResponse
} from '$lib/services/chatBackupCrypto';

import { manager } from '$lib/services/accountManager.svelte';
import {
	ensureGroupsLoaded,
	listChatGroups,
	reloadChatGroupsForOwner,
	importChatGroups,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import {
	chatCoordinatorsStore,
	importChatCoordinators,
	type StoredCoordinator
} from '$lib/services/chatCoordinators.svelte';
import { requireActiveAccount } from '$lib/services/chatRuntime';
import { normalizePubKey } from '$lib/utils';

const BACKUP_MAGIC = 'cordn-web-backup';
const BACKUP_SCHEMA_VERSION = 1;

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/**
 * StoredChatGroup with `joinEpoch` as string — the only bigint field, and
 * JSON.stringify throws on bigint. Round-trips via groupToBackup/groupFromBackup.
 */
type BackupGroup = Omit<StoredChatGroup, 'joinEpoch'> & { joinEpoch: string };

export interface BackupManifest {
	magic: typeof BACKUP_MAGIC;
	schemaVersion: typeof BACKUP_SCHEMA_VERSION;
	createdAt: number;
	appVersion: string;
	ownerPubkey: string;
	includeMessages: boolean;
	encrypted: false;
}

export interface BackupDocument {
	manifest: BackupManifest;
	accounts: SerializedAccount[];
	activeAccountId: string | null;
	coordinators: StoredCoordinator[];
	groups: BackupGroup[];
}

export interface EncryptedEnvelope {
	magic: typeof BACKUP_MAGIC;
	encrypted: true;
	kdf: {
		algorithm: 'PBKDF2';
		hash: typeof PBKDF2_HASH;
		iterations: number;
		salt: string;
	};
	cipher: {
		algorithm: 'AES-GCM';
		iv: string;
	};
	ciphertext: string;
}

/** The raw backup key wrapped by a passphrase-derived key. Self-contained recovery material:
 * carried inside every v2 envelope so the file alone (plus the passphrase) restores on a new
 * device. Re-wrapping (passphrase change) touches only this entry, never the data. */
export interface PassphraseWrappedBackupKey {
	kind: 'passphrase';
	kdf: {
		algorithm: 'PBKDF2';
		hash: typeof PBKDF2_HASH;
		iterations: number;
		salt: string;
	};
	cipher: {
		algorithm: 'AES-GCM';
		iv: string;
	};
	wrapped: string;
}

/** v2 envelope: the document is encrypted with a random backup key (no KDF on the hot path),
 * and the backup key itself is wrapped inside for recovery. Distinguished from v1 at import by
 * `schemaVersion: 2` + the `data` field. */
export interface EncryptedEnvelopeV2 {
	magic: typeof BACKUP_MAGIC;
	encrypted: true;
	schemaVersion: 2;
	data: {
		algorithm: 'AES-GCM';
		iv: string;
		ciphertext: string;
	};
	wrappedKeys: PassphraseWrappedBackupKey[];
}

export type AnyEncryptedEnvelope = EncryptedEnvelope | EncryptedEnvelopeV2;

export interface ExportOptions {
	includeMessages?: boolean;
	passphrase?: string | null;
	/** Raw backup key (base64) for automated backups — produces a v2 envelope with no KDF on the
	 * data path. When `passphrase` is also given, the key is additionally wrapped inside the
	 * envelope as migration material. */
	backupKey?: string | null;
	/** Embed an already-wrapped backup key (wrapped once at enable time) instead of re-running
	 * the KDF per export — the automation service's zero-KDF hot path. */
	preWrappedKey?: PassphraseWrappedBackupKey | null;
}

export interface ImportOptions {
	passphrase?: string | null;
	/** Raw backup key (base64) for v2 envelopes (device key or typed recovery key). */
	backupKey?: string | null;
	/** Acknowledge a cross-account restore (active pubkey not in the backup). */
	confirmCrossAccount?: boolean;
}

export interface ImportResult {
	accounts: number;
	coordinators: number;
	groups: number;
	encrypted: boolean;
}

class BackupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BackupError';
	}
}

/**
 * Thrown by importClientData when the active account's pubkey is not among the
 * backup's accounts, before any state is mutated. Re-call import with
 * `confirmCrossAccount: true` to proceed.
 */
export class CrossAccountRestoreError extends BackupError {
	activePubkey: string;
	backupPubkeys: string[];
	constructor(activePubkey: string, backupPubkeys: string[]) {
		super('The active account is not in this backup');
		this.name = 'CrossAccountRestoreError';
		this.activePubkey = activePubkey;
		this.backupPubkeys = backupPubkeys;
	}
}

function groupToBackup(group: StoredChatGroup): BackupGroup {
	const { joinEpoch, ...rest } = group;
	return { ...rest, joinEpoch: joinEpoch.toString() };
}

function groupFromBackup(group: BackupGroup): StoredChatGroup {
	return { ...group, joinEpoch: BigInt(group.joinEpoch) };
}

/**
 * Run one crypto op in the backup worker and resolve its reply. Creates a
 * throwaway worker per call — backup/restore is rare, so no pool, and terminate
 * on the first reply or startup error to avoid leaks. Encrypt can't fail at
 * the crypto layer (only noble calls on valid inputs), so its failures surface
 * as a promise rejection via onerror; decrypt can fail (wrong passphrase /
 * corruption), so its return includes the error variant.
 *
 * `new Worker(new URL(..., import.meta.url), { type: 'module' })` is the
 * standard Vite module-worker pattern: Vite bundles chatBackupWorker.ts as a
 * separate chunk, so @noble never lands in the main bundle.
 */
function runBackupWorker(req: EncryptRequest): Promise<EncryptResponse>;
function runBackupWorker(req: DecryptRequest): Promise<DecryptResponse | ErrorResponse>;
function runBackupWorker(req: EncryptWithKeyRequest): Promise<EncryptWithKeyResponse>;
function runBackupWorker(
	req: DecryptWithKeyRequest
): Promise<DecryptWithKeyResponse | ErrorResponse>;
function runBackupWorker(req: WrapKeyRequest): Promise<WrapKeyResponse>;
function runBackupWorker(req: UnwrapKeyRequest): Promise<UnwrapKeyResponse | ErrorResponse>;
function runBackupWorker(req: BackupWorkerRequest): Promise<BackupWorkerResponse> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./chatBackupWorker.ts', import.meta.url), {
			type: 'module'
		});
		const finish = (result: BackupWorkerResponse) => {
			worker.terminate();
			resolve(result);
		};
		worker.onmessage = (event: MessageEvent<BackupWorkerResponse>) => finish(event.data);
		worker.onerror = (event) => {
			worker.terminate();
			reject(new BackupError(event.message || 'Backup worker failed to start'));
		};
		worker.postMessage(req);
	});
}

async function encryptDocument(
	doc: BackupDocument,
	opts: {
		passphrase?: string | null;
		backupKey?: string | null;
		preWrappedKey?: PassphraseWrappedBackupKey | null;
	}
): Promise<string> {
	const plaintext = JSON.stringify(doc);
	if (opts.backupKey) {
		// v2: data under the raw backup key (instant, no KDF), key optionally wrapped inside.
		const res = await runBackupWorker({
			op: 'encryptWithKey',
			key: opts.backupKey,
			plaintext
		});
		let wrappedKeys: PassphraseWrappedBackupKey[];
		if (opts.preWrappedKey) {
			// Wrapped once at enable time — no KDF on the backup hot path.
			wrappedKeys = [opts.preWrappedKey];
		} else if (opts.passphrase && opts.passphrase.length > 0) {
			wrappedKeys = [await wrapBackupKeyWithPassphrase(opts.passphrase, opts.backupKey)];
		} else {
			wrappedKeys = [];
		}
		const envelope: EncryptedEnvelopeV2 = {
			magic: BACKUP_MAGIC,
			encrypted: true,
			schemaVersion: 2,
			data: { algorithm: 'AES-GCM', iv: res.iv, ciphertext: res.ciphertext },
			wrappedKeys
		};
		return JSON.stringify(envelope, null, 2);
	}
	// v1: passphrase-only envelope (manual export path, unchanged).
	const res = await runBackupWorker({
		op: 'encrypt',
		passphrase: opts.passphrase as string,
		plaintext
	});
	const envelope: EncryptedEnvelope = {
		magic: BACKUP_MAGIC,
		encrypted: true,
		kdf: {
			algorithm: 'PBKDF2',
			hash: PBKDF2_HASH,
			iterations: PBKDF2_ITERATIONS,
			salt: res.salt
		},
		cipher: { algorithm: 'AES-GCM', iv: res.iv },
		ciphertext: res.ciphertext
	};
	return JSON.stringify(envelope, null, 2);
}

function isV2Envelope(envelope: object): boolean {
	return 'data' in envelope && 'wrappedKeys' in envelope;
}

function parsePlaintext(plaintext: string): BackupDocument {
	try {
		return JSON.parse(plaintext) as BackupDocument;
	} catch {
		throw new BackupError('Decrypted backup is not valid JSON');
	}
}

/** Decrypt either envelope version into a backup document. Credential precedence: explicit
 * backupKey (device key or typed recovery key) first, then passphrase unwrap of any wrapped-key
 * entry (v2 only), then v1 passphrase decryption. */
async function decryptEncryptedEnvelope(
	envelope: EncryptedEnvelope | EncryptedEnvelopeV2,
	opts: { passphrase?: string | null; backupKey?: string | null }
): Promise<BackupDocument> {
	let plaintext: string;
	try {
		if (isV2Envelope(envelope)) {
			const v2 = envelope as EncryptedEnvelopeV2;
			let key = opts.backupKey && opts.backupKey.length > 0 ? opts.backupKey : null;
			if (!key && opts.passphrase && opts.passphrase.length > 0) {
				for (const entry of v2.wrappedKeys) {
					if (entry.kind !== 'passphrase') continue;
					const res = await runBackupWorker({
						op: 'unwrapKey',
						passphrase: opts.passphrase,
						salt: entry.kdf.salt,
						iv: entry.cipher.iv,
						wrapped: entry.wrapped
					});
					if (res.ok) {
						key = res.key;
						break;
					}
				}
				if (!key) throw new BackupError('Wrong passphrase or corrupted backup');
			}
			if (!key) {
				throw new BackupError(
					'This backup is encrypted with a backup key — enter its recovery key or passphrase'
				);
			}
			const res = await runBackupWorker({
				op: 'decryptWithKey',
				key,
				iv: v2.data.iv,
				ciphertext: v2.data.ciphertext
			});
			if (!res.ok) throw new BackupError('Wrong backup key or corrupted backup');
			plaintext = res.plaintext;
		} else {
			const v1 = envelope as EncryptedEnvelope;
			if (v1.kdf?.algorithm !== 'PBKDF2' || v1.cipher?.algorithm !== 'AES-GCM') {
				throw new BackupError('Unsupported encryption parameters in backup');
			}
			if (!opts.passphrase || opts.passphrase.length === 0) {
				throw new BackupError('This backup is encrypted — provide a passphrase');
			}
			const res = await runBackupWorker({
				op: 'decrypt',
				passphrase: opts.passphrase,
				salt: v1.kdf.salt,
				iv: v1.cipher.iv,
				ciphertext: v1.ciphertext
			});
			if (!res.ok) {
				// gcm.decrypt tag mismatch in the worker; keep the cause opaque.
				throw new BackupError('Wrong passphrase or corrupted backup');
			}
			plaintext = res.plaintext;
		}
	} catch (error) {
		throw error instanceof BackupError
			? error
			: new BackupError('Wrong passphrase or corrupted backup');
	}
	return parsePlaintext(plaintext);
}

/**
 * Serialize the backup document. Returns the JSON text (not a Blob) so the native save path can
 * hand the string straight to the platform save-picker without the Blob→base64 re-encoding that
 * OOM'd large backups on Android; web callers wrap it in a Blob for the `<a download>` path.
 */
export async function exportClientData(options: ExportOptions = {}): Promise<string> {
	if (!browser) throw new BackupError('Backup can only run in the browser');
	const {
		includeMessages = true,
		passphrase = null,
		backupKey = null,
		preWrappedKey = null
	} = options;
	const account = requireActiveAccount('Log in to export a backup');
	const ownerPubkey = normalizePubKey(account.pubkey);

	await ensureGroupsLoaded();
	const groups = listChatGroups().map((group) => {
		// Snapshots and sync issues are always regenerable (snapshots rebuild
		// from ClientState in loadAndNormalizeChatGroup; sync issues re-surface
		// on re-stream), so they're never worth the bytes regardless of the
		// messages flag.
		const stripped: StoredChatGroup = {
			...group,
			syncIssues: [],
			snapshots: []
		};
		return groupToBackup(includeMessages ? stripped : { ...stripped, messages: [] });
	});

	const doc: BackupDocument = {
		manifest: {
			magic: BACKUP_MAGIC,
			schemaVersion: BACKUP_SCHEMA_VERSION,
			createdAt: Date.now(),
			appVersion: APP_VERSION,
			ownerPubkey,
			includeMessages,
			encrypted: false
		},
		accounts: manager.toJSON(),
		activeAccountId: manager.getActive()?.id ?? null,
		coordinators: chatCoordinatorsStore.coordinators.map((c) => ({ ...c })),
		groups
	};

	const serialized =
		passphrase || backupKey
			? await encryptDocument(doc, { passphrase, backupKey, preWrappedKey })
			: JSON.stringify(doc, null, 2);

	return serialized;
}

/** Wrap a raw backup key with a passphrase (used at enable / passphrase-change time by the
 * automation service so it never needs its own worker plumbing). */
export async function wrapBackupKeyWithPassphrase(
	passphrase: string,
	backupKey: string
): Promise<PassphraseWrappedBackupKey> {
	const wrap = await runBackupWorker({ op: 'wrapKey', passphrase, key: backupKey });
	return {
		kind: 'passphrase',
		kdf: {
			algorithm: 'PBKDF2',
			hash: PBKDF2_HASH,
			iterations: PBKDF2_ITERATIONS,
			salt: wrap.salt
		},
		cipher: { algorithm: 'AES-GCM', iv: wrap.iv },
		wrapped: wrap.wrapped
	};
}

export async function importClientData(
	input: File | string,
	options: ImportOptions = {}
): Promise<ImportResult> {
	if (!browser) throw new BackupError('Backup can only run in the browser');
	const { passphrase = null, backupKey = null } = options;

	const text = typeof input === 'string' ? input : await input.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BackupError('File is not valid JSON');
	}

	const envelope = parsed as Partial<EncryptedEnvelope & EncryptedEnvelopeV2> | undefined;
	const isEncrypted = envelope?.magic === BACKUP_MAGIC && envelope.encrypted === true;

	let doc: BackupDocument;
	if (isEncrypted) {
		doc = await decryptEncryptedEnvelope(envelope as AnyEncryptedEnvelope, {
			passphrase,
			backupKey
		});
	} else {
		doc = parsed as BackupDocument;
	}

	if (doc.manifest?.magic !== BACKUP_MAGIC) {
		throw new BackupError('Not a Cordn backup file');
	}
	if (doc.manifest.schemaVersion > BACKUP_SCHEMA_VERSION) {
		throw new BackupError(
			`Backup schema v${doc.manifest.schemaVersion} is newer than this client supports (v${BACKUP_SCHEMA_VERSION})`
		);
	}

	// Cross-account guard: refuse to silently switch identities. Only fires when
	// the active pubkey is absent from the backup's accounts; the same-pubkey
	// case (signer mismatch) and the no-active-account case (fresh device) pass
	// through unchanged. Re-call with confirmCrossAccount to override.
	if (!options.confirmCrossAccount) {
		const active = manager.getActive();
		if (active) {
			const backupPubkeys = new Set(doc.accounts.map((a) => normalizePubKey(a.pubkey)));
			if (!backupPubkeys.has(normalizePubKey(active.pubkey))) {
				throw new CrossAccountRestoreError(active.pubkey, [...backupPubkeys]);
			}
		}
	}

	const beforeActiveId = manager.getActive()?.id;

	// Persist groups to storage first so the active-account subscriber's reload
	// (fired when we activate below) reads them into the in-memory store.
	await importChatGroups(doc.groups.map(groupFromBackup));
	importChatCoordinators(doc.coordinators);

	const identityCount = mergeRestoredAccounts(doc.accounts, doc.activeAccountId);

	// If the active account didn't change (e.g. backup's active pubkey was
	// already the local one), the active$ subscriber never fired and the
	// in-memory group store is stale — sync it from storage explicitly.
	const afterAccount = manager.getActive();
	if (afterAccount && afterAccount.id === beforeActiveId) {
		await reloadChatGroupsForOwner(afterAccount.pubkey);
	}

	return {
		accounts: identityCount,
		coordinators: doc.coordinators.length,
		groups: doc.groups.length,
		encrypted: isEncrypted
	};
}

/**
 * Merge backup accounts into the manager by pubkey (root-cause fix for two
 * bugs at once):
 *  - Dedupe: the manager only dedupes accounts by id, so same-pubkey accounts
 *    with different ids (a known duplication bug) would otherwise accumulate.
 *    Collapse same-pubkey entries in the backup before importing.
 *  - Signer mismatch: if the device is already logged in for a pubkey (e.g.
 *    with an nsec) but the backup holds an extension account for that pubkey,
 *    the local account wins — its signer actually works in this browser.
 *    Activating by pubkey (not the backup's arbitrary id) lands on whichever
 *    account (local or imported) survived for that identity.
 */
function mergeRestoredAccounts(
	serialized: SerializedAccount[],
	activeAccountId: string | null
): number {
	// Collapse same-pubkey duplicates within the backup.
	const deduped = new Map<string, SerializedAccount>();
	for (const json of serialized) {
		if (!deduped.has(json.pubkey)) deduped.set(json.pubkey, json);
	}

	// Local accounts win on pubkey collision.
	const localPubkeys = new Set(manager.accounts.map((account) => account.pubkey));
	const toImport = [...deduped.values()].filter((json) => !localPubkeys.has(json.pubkey));
	if (toImport.length > 0) {
		// quiet=true: skip accounts whose type isn't registered in this client.
		manager.fromJSON(toImport, true);
	}

	// Activate by pubkey so the working local account (if any) is used.
	if (activeAccountId) {
		const activeJson = serialized.find((json) => json.id === activeAccountId);
		const target = activeJson ? manager.getAccountForPubkey(activeJson.pubkey) : undefined;
		if (target) manager.setActive(target.id);
	}

	return deduped.size;
}
