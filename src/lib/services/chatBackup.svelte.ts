/**
 * Client data backup / restore.
 *
 * The backup is a dumb object serializer: it snapshots the in-memory group
 * objects (which carry MLS ClientState secrets), the active account's private
 * keys, and the coordinator list (needed for relay resolution). It does not
 * model sync, decryptability, or MLS — those concerns live inside the group
 * object, so when the since_epoch → cursor migration lands the backup needs
 * zero changes; whatever fields exist on the group ride along.
 *
 * Key packages, welcome/join notifications, presence, and sent-join-requests
 * are intentionally excluded: all regenerable (key packages via coordinator
 * reconcile, the rest re-fetched on re-stream).
 *
 * Security: the document carries nsec private keys and group secrets, so the
 * passphrase-encrypted envelope (WebCrypto PBKDF2 + AES-GCM) is the default.
 * Unencrypted export/import is exposed as an explicit opt-in for dev/inspection.
 */
import { browser } from '$app/environment';
import { bytesToBase64, base64ToBytes } from 'ts-mls';
import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { SerializedAccount } from 'applesauce-accounts';

import { manager } from '$lib/services/accountManager.svelte';
import {
	chatGroupsStore,
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

export const BACKUP_MAGIC = 'cordn-web-backup';
export const BACKUP_SCHEMA_VERSION = 1;

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

// ponytail: OWASP 2023 floor for PBKDF2-SHA256. @noble/hashes is sync pure-JS,
// so ~0.3s once per export/import — not worth tuning lower.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

function randomBytes(len: number): Uint8Array {
	// ponytail: getRandomValues works in non-secure contexts too (only
	// crypto.subtle needs HTTPS), so restore just works on http:// self-host.
	return crypto.getRandomValues(new Uint8Array(len));
}

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

export interface ExportOptions {
	includeMessages?: boolean;
	passphrase?: string | null;
}

export interface ImportOptions {
	passphrase?: string | null;
	/** Acknowledge a cross-account restore (active pubkey not in the backup). */
	confirmCrossAccount?: boolean;
}

export interface ImportResult {
	accounts: number;
	coordinators: number;
	groups: number;
	encrypted: boolean;
}

export class BackupError extends Error {
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

function deriveAesKey(passphrase: string, salt: Uint8Array): Uint8Array {
	return pbkdf2(sha256, new TextEncoder().encode(passphrase), salt, {
		c: PBKDF2_ITERATIONS,
		dkLen: KEY_BYTES
	});
}

async function encryptDocument(doc: BackupDocument, passphrase: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const iv = randomBytes(IV_BYTES);
	const key = deriveAesKey(passphrase, salt);
	const plaintext = new TextEncoder().encode(JSON.stringify(doc));
	const ciphertext = gcm(key, iv).encrypt(plaintext);
	const envelope: EncryptedEnvelope = {
		magic: BACKUP_MAGIC,
		encrypted: true,
		kdf: {
			algorithm: 'PBKDF2',
			hash: PBKDF2_HASH,
			iterations: PBKDF2_ITERATIONS,
			salt: bytesToBase64(salt)
		},
		cipher: { algorithm: 'AES-GCM', iv: bytesToBase64(iv) },
		ciphertext: bytesToBase64(ciphertext)
	};
	return JSON.stringify(envelope, null, 2);
}

async function decryptEnvelope(
	envelope: EncryptedEnvelope,
	passphrase: string
): Promise<BackupDocument> {
	if (envelope.kdf?.algorithm !== 'PBKDF2' || envelope.cipher?.algorithm !== 'AES-GCM') {
		throw new BackupError('Unsupported encryption parameters in backup');
	}
	const salt = base64ToBytes(envelope.kdf.salt);
	const iv = base64ToBytes(envelope.cipher.iv);
	const key = deriveAesKey(passphrase, salt);
	let plaintext: Uint8Array;
	try {
		plaintext = gcm(key, iv).decrypt(base64ToBytes(envelope.ciphertext));
	} catch {
		throw new BackupError('Wrong passphrase or corrupted backup');
	}
	try {
		return JSON.parse(new TextDecoder().decode(plaintext)) as BackupDocument;
	} catch {
		throw new BackupError('Decrypted backup is not valid JSON');
	}
}

export async function exportClientData(options: ExportOptions = {}): Promise<Blob> {
	if (!browser) throw new BackupError('Backup can only run in the browser');
	const { includeMessages = true, passphrase = null } = options;
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
		passphrase && passphrase.length > 0
			? await encryptDocument(doc, passphrase)
			: JSON.stringify(doc, null, 2);

	return new Blob([serialized], { type: 'application/json' });
}

export async function importClientData(
	file: File,
	options: ImportOptions = {}
): Promise<ImportResult> {
	if (!browser) throw new BackupError('Backup can only run in the browser');
	const { passphrase = null } = options;

	let parsed: unknown;
	try {
		parsed = JSON.parse(await file.text());
	} catch {
		throw new BackupError('File is not valid JSON');
	}

	const envelope = parsed as Partial<EncryptedEnvelope> | undefined;
	const isEncrypted = envelope?.magic === BACKUP_MAGIC && envelope.encrypted === true;

	let doc: BackupDocument;
	if (isEncrypted) {
		if (!passphrase || passphrase.length === 0) {
			throw new BackupError('This backup is encrypted — provide a passphrase');
		}
		doc = await decryptEnvelope(envelope as EncryptedEnvelope, passphrase);
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

// Re-exported so callers can read the live group count without pulling the
// whole groups module (keeps the route file's imports tidy).
export { chatGroupsStore };
