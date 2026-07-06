import {
	base64ToBytes,
	bytesToBase64,
	encode,
	generateKeyPackage,
	keyPackageEncoder,
	keyPackageDecoder,
	makeKeyPackageRef,
	privateKeyPackageDecoder,
	privateKeyPackageEncoder,
	type KeyPackage,
	type PrivateKeyPackage
} from 'ts-mls';
import {
	CLI_CIPHERSUITE,
	createCordnMetadataCapabilities,
	createCredential,
	ensureLastResortKeyPackageExtension,
	isLastResortKeyPackage,
	getCordnCipherSuite
} from '$lib/services/chatMlsUtils';
import { listKnownCoordinatorKeys } from '$lib/services/chatCoordinators.svelte';
import { markCoordinatorUsed } from '$lib/services/chatCoordinators.svelte';
import {
	requireActiveAccount,
	withCoordinatorClient,
	withCoordinatorClientRetry
} from '$lib/services/chatRuntime';
import { getCoordinatorHealthTone } from '$lib/services/coordinatorHealth.svelte';
import {
	getChatStorage,
	type StoredChatKeyPackageRecord as StoredBinaryChatKeyPackageRecord
} from '$lib/storage/chatStorage';
import { normalizePubKey } from '$lib/utils';
import { bytesToHex } from 'applesauce-core/helpers';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { fetchCoordinatorAvailableKeyPackages } from '$lib/queries/chatKeyPackageQueries';
import { type LastResortKeyPackageEntry } from '$lib/services/multiDevice';
import { onMetaStateChange } from '$lib/services/multiDevice.svelte';

function isMissingRemoteKeyPackageRemovalError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes('invalid input: expected object, received undefined') ||
		message.includes('expected object, received undefined')
	);
}

export interface StoredKeyPackageRecord {
	id: string;
	ownerPubkey: string;
	label: string;
	isLastResort: boolean;
	keyPackageRef: string;
	keyPackageBase64: string;
	privateKeyPackageBase64: string;
	cipherSuite: string;
	createdAt: number;
	publishedCoordinatorKeys: string[];
}

export const chatKeyPackagesStore = $state<{ keyPackages: StoredKeyPackageRecord[] }>({
	keyPackages: []
});

let storageReady: Promise<void> | null = null;
let persistKeyPackagesPromise: Promise<void> = Promise.resolve();

function fromStoredRecord(record: StoredBinaryChatKeyPackageRecord): StoredKeyPackageRecord {
	return {
		id: record.id,
		ownerPubkey: record.ownerPubkey,
		label: record.label,
		isLastResort: record.isLastResort,
		keyPackageRef: record.keyPackageRef,
		keyPackageBase64: bytesToBase64(record.keyPackageBytes),
		privateKeyPackageBase64: bytesToBase64(record.privateKeyPackageBytes),
		cipherSuite: record.cipherSuite,
		createdAt: record.createdAt,
		publishedCoordinatorKeys: [...record.publishedCoordinatorKeys]
	};
}

function toStoredRecord(record: StoredKeyPackageRecord): StoredBinaryChatKeyPackageRecord {
	return {
		id: record.id,
		ownerPubkey: record.ownerPubkey,
		label: record.label,
		isLastResort: record.isLastResort,
		keyPackageRef: record.keyPackageRef,
		keyPackageBytes: base64ToBytes(record.keyPackageBase64),
		privateKeyPackageBytes: base64ToBytes(record.privateKeyPackageBase64),
		cipherSuite: record.cipherSuite,
		createdAt: record.createdAt,
		publishedCoordinatorKeys: [...record.publishedCoordinatorKeys]
	};
}

async function loadKeyPackages() {
	const storage = await getChatStorage();
	const records = await storage.listKeyPackages();
	chatKeyPackagesStore.keyPackages = records.map(fromStoredRecord);
}

async function ensureKeyPackagesLoaded() {
	storageReady ??= loadKeyPackages();
	await storageReady;
}

function persistKeyPackages(keyPackages: StoredKeyPackageRecord[]) {
	persistKeyPackagesPromise = persistKeyPackagesPromise
		.then(async () => {
			const storage = await getChatStorage();
			await storage.replaceKeyPackages(keyPackages.map(toStoredRecord));
		})
		.catch(() => undefined);
	return persistKeyPackagesPromise;
}

function getActivePubkey(): string {
	return requireActiveAccount('You must be logged in to create a key package').pubkey;
}

async function getCipherSuite() {
	return getCordnCipherSuite();
}

void ensureKeyPackagesLoaded();

export function listChatKeyPackages(ownerPubkey?: string): StoredKeyPackageRecord[] {
	const filtered = ownerPubkey
		? chatKeyPackagesStore.keyPackages.filter((entry) => entry.ownerPubkey === ownerPubkey)
		: chatKeyPackagesStore.keyPackages;
	return [...filtered].sort((a, b) => b.createdAt - a.createdAt);
}

export async function purgeCoordinatorKeyPackages(
	coordinatorKey: string,
	deleteRefs: string[] = []
): Promise<void> {
	const normalizedCoordinator = normalizePubKey(coordinatorKey);
	const publishedEntries = chatKeyPackagesStore.keyPackages.filter((entry) =>
		entry.publishedCoordinatorKeys.includes(normalizedCoordinator)
	);

	if (publishedEntries.length === 0) {
		// Fall through to the deleteRefs sweep + reconcile below.
	} else if (getCoordinatorHealthTone(normalizedCoordinator) !== 'healthy') {
		// Coordinator not connected — the remote RemoveKeyPackages RPC would hang
		// until the SDK timeout, stalling the whole delete. Prune
		// publishedCoordinatorKeys locally instead; records with no remaining use
		// are dropped by the deleteRefs sweep below.
		await setKeyPackages(
			chatKeyPackagesStore.keyPackages.map((entry) =>
				entry.publishedCoordinatorKeys.includes(normalizedCoordinator)
					? {
							...entry,
							publishedCoordinatorKeys: entry.publishedCoordinatorKeys.filter(
								(key) => key !== normalizedCoordinator
							)
						}
					: entry
			)
		);
	} else {
		for (const entry of publishedEntries) {
			try {
				await removeChatKeyPackage(entry.keyPackageRef, {
					coordinatorKey: normalizedCoordinator
				});
			} catch (error) {
				console.warn(
					`Failed to remove key package ${entry.keyPackageRef} from coordinator ${normalizedCoordinator}:`,
					error instanceof Error ? error.message : error
				);
			}
		}
	}
	// Drop only the consumed records the caller resolved for THIS coordinator.
	// Never nuke records attributable to another coordinator's groups — the old
	// global "publishedCoordinatorKeys.length === 0" sweep did exactly that.
	if (deleteRefs.length > 0) {
		await setKeyPackages(
			chatKeyPackagesStore.keyPackages.filter((entry) => !deleteRefs.includes(entry.keyPackageRef))
		);
	}
	// ponytail: no reconcile here. It fetches ListAvailableKeyPackages from every
	// known coordinator serially and hangs on offline ones until the SDK timeout,
	// blocking the whole purge (and the dialog spinner). Local state is already
	// correct via the prune + deleteRefs sweep above; drift-repair for *other*
	// coordinators runs in the chat layout on account startup
	// (shouldReconcilePublishedKeyPackages).
}

export async function deleteChatKeyPackagesForOwner(ownerPubkey: string): Promise<void> {
	const normalizedOwner = normalizePubKey(ownerPubkey);
	chatKeyPackagesStore.keyPackages = chatKeyPackagesStore.keyPackages.filter(
		(entry) => normalizePubKey(entry.ownerPubkey) !== normalizedOwner
	);
	const storage = await getChatStorage();
	await storage.deleteKeyPackagesByOwner(normalizedOwner);
}

export function getChatKeyPackage(keyPackageRef: string): StoredKeyPackageRecord | undefined {
	return chatKeyPackagesStore.keyPackages.find((entry) => entry.keyPackageRef === keyPackageRef);
}

/**
 * Refs of local key packages that are provably dead: already consumed to join
 * an existing group (`consumedRefs`, i.e. some `joinedWithKeyPackageRef`) AND
 * not published to any coordinator. A consumed KP's private bytes are
 * cryptographically spent (the group state is self-contained), and an
 * unpublished KP can never receive a new welcome — so the local record serves
 * no future action. Published KPs (incl. last-resort, which can back multiple
 * welcomes) are always kept. Single source of truth for both the prune and
 * the config-page zombie count.
 */
export function listZombieKeyPackageRefs(consumedRefs: string[]): string[] {
	if (consumedRefs.length === 0) return [];
	return chatKeyPackagesStore.keyPackages
		.filter(
			(entry) =>
				entry.publishedCoordinatorKeys.length === 0 && consumedRefs.includes(entry.keyPackageRef)
		)
		.map((entry) => entry.keyPackageRef);
}

/** Drop the zombie key packages identified by {@link listZombieKeyPackageRefs}. */
export async function pruneZombieKeyPackages(consumedRefs: string[]): Promise<void> {
	const refs = listZombieKeyPackageRefs(consumedRefs);
	if (refs.length === 0) return;
	await setKeyPackages(
		chatKeyPackagesStore.keyPackages.filter((entry) => !refs.includes(entry.keyPackageRef))
	);
}

async function setKeyPackages(keyPackages: StoredKeyPackageRecord[]) {
	chatKeyPackagesStore.keyPackages = keyPackages;
	await persistKeyPackages(keyPackages);
}

function dedupeStrings(values: string[]): string[] {
	return values.filter((value, index) => values.indexOf(value) === index);
}

function buildKeyPackageLabel(input: {
	label?: string;
	ownerPubkey: string;
	isLastResort?: boolean;
}) {
	const trimmed = input.label?.trim();
	if (trimmed) return trimmed;
	const suffix = input.isLastResort ? 'Last resort' : 'Key package';
	return `${suffix} ${input.ownerPubkey.slice(0, 8)}`;
}

export async function createChatKeyPackage(): Promise<{
	record: StoredKeyPackageRecord;
	keyPackage: KeyPackage;
	privateKeyPackage: PrivateKeyPackage;
}>;
export async function createChatKeyPackage(input: {
	label?: string;
	isLastResort?: boolean;
	publishCoordinatorKey?: string;
}): Promise<{
	record: StoredKeyPackageRecord;
	keyPackage: KeyPackage;
	privateKeyPackage: PrivateKeyPackage;
}>;
export async function createChatKeyPackage(input?: {
	label?: string;
	isLastResort?: boolean;
	publishCoordinatorKey?: string;
}): Promise<{
	record: StoredKeyPackageRecord;
	keyPackage: KeyPackage;
	privateKeyPackage: PrivateKeyPackage;
}> {
	const ownerPubkey = getActivePubkey();
	const cipherSuite = await getCipherSuite();
	const nowSeconds = Math.floor(Date.now() / 1000);
	const generated = await generateKeyPackage({
		credential: createCredential(ownerPubkey),
		cipherSuite,
		capabilities: createCordnMetadataCapabilities(),
		extensions: input?.isLastResort ? ensureLastResortKeyPackageExtension([]) : undefined,
		lifetime: {
			notBefore: BigInt(nowSeconds - 86400),
			// ~100-year notAfter: effectively disables MLS-level key package expiry
			notAfter: BigInt(nowSeconds + 3153600000)
		}
	});
	const isLastResort = isLastResortKeyPackage(generated.publicPackage);

	const keyPackageRef = bytesToHex(
		await makeKeyPackageRef(generated.publicPackage, cipherSuite.hash)
	);
	const timestamp = Date.now();
	const record: StoredKeyPackageRecord = {
		id: `${ownerPubkey.slice(0, 8)}-${timestamp}`,
		ownerPubkey,
		label: buildKeyPackageLabel({
			label: input?.label,
			ownerPubkey,
			isLastResort
		}),
		isLastResort,
		keyPackageRef,
		keyPackageBase64: bytesToBase64(encode(keyPackageEncoder, generated.publicPackage)),
		privateKeyPackageBase64: bytesToBase64(
			encode(privateKeyPackageEncoder, generated.privatePackage)
		),
		cipherSuite: CLI_CIPHERSUITE,
		createdAt: timestamp,
		publishedCoordinatorKeys: []
	};

	await setKeyPackages([record, ...chatKeyPackagesStore.keyPackages]);

	if (input?.publishCoordinatorKey?.trim()) {
		await publishChatKeyPackage(record.keyPackageRef, input.publishCoordinatorKey);
	}

	if (isLastResort) {
		// spec §10.5: a new/rotated last-resort key package triggers a meta
		// republish so the meta document carries it for cross-device Welcome
		// coverage (spec §11.5).
		onMetaStateChange();
	}

	return {
		record,
		keyPackage: generated.publicPackage,
		privateKeyPackage: generated.privatePackage
	};
}

export function decodeStoredKeyPackage(record: StoredKeyPackageRecord): {
	keyPackage: KeyPackage;
	privateKeyPackage: PrivateKeyPackage;
} {
	const keyPackageDecoded = keyPackageDecoder(base64ToBytes(record.keyPackageBase64), 0);
	const privateKeyPackageDecoded = privateKeyPackageDecoder(
		base64ToBytes(record.privateKeyPackageBase64),
		0
	);
	if (!keyPackageDecoded || !privateKeyPackageDecoded) {
		throw new Error(`Unable to decode key package ${record.keyPackageRef}`);
	}
	return {
		keyPackage: keyPackageDecoded[0],
		privateKeyPackage: privateKeyPackageDecoded[0]
	};
}

export async function publishChatKeyPackage(keyPackageRef: string, coordinatorKey: string) {
	const record = getChatKeyPackage(keyPackageRef);
	if (!record) {
		throw new Error('Key package not found');
	}
	const normalizedCoordinator = normalizePubKey(coordinatorKey);
	const account = requireActiveAccount('You must be logged in to manage key packages');
	const result = await withCoordinatorClientRetry(account, normalizedCoordinator, (client) =>
		client.PublishKeyPackage({
			kp_ref: record.keyPackageRef,
			kp_64: record.keyPackageBase64
		})
	);
	markCoordinatorUsed(normalizedCoordinator);
	await markKeyPackagePublished(record.keyPackageRef, normalizedCoordinator, result.last_resort);
	void queryClient.invalidateQueries({
		queryKey: chatQueryKeys.coordinators(account.pubkey)
	});
}

export async function removeChatKeyPackage(
	keyPackageRef: string,
	input: { coordinatorKey?: string; localOnly?: boolean } = {}
) {
	const record = getChatKeyPackage(keyPackageRef);
	const normalizedCoordinator = input.coordinatorKey?.trim()
		? normalizePubKey(input.coordinatorKey)
		: undefined;
	const shouldRemoveRemotely = !input.localOnly;

	if (!record && !normalizedCoordinator) {
		throw new Error('Key package not found');
	}

	if (shouldRemoveRemotely) {
		const account = requireActiveAccount('You must be logged in to manage key packages');
		const coordinatorKeys = normalizedCoordinator
			? [normalizedCoordinator]
			: dedupeStrings(record?.publishedCoordinatorKeys ?? []);

		for (const coordinatorKey of coordinatorKeys) {
			try {
				await withCoordinatorClient(account, coordinatorKey, (client) =>
					client.RemoveKeyPackages({ kp_refs: [keyPackageRef] })
				);
			} catch (error) {
				if (!isMissingRemoteKeyPackageRemovalError(error)) {
					throw error;
				}
			}
		}

		// Mirror publishChatKeyPackage: cascade-invalidate so the shared
		// available-key-packages query (directory, dialog, coordinator page) refreshes.
		void queryClient.invalidateQueries({
			queryKey: chatQueryKeys.coordinators(account.pubkey)
		});
	}

	if (record) {
		if (normalizedCoordinator && shouldRemoveRemotely) {
			await setKeyPackages(
				chatKeyPackagesStore.keyPackages.map((entry) =>
					entry.keyPackageRef !== keyPackageRef
						? entry
						: {
								...entry,
								publishedCoordinatorKeys: entry.publishedCoordinatorKeys.filter(
									(entryCoordinatorKey) => entryCoordinatorKey !== normalizedCoordinator
								)
							}
				)
			);
			return;
		}

		await setKeyPackages(
			chatKeyPackagesStore.keyPackages.filter((entry) => entry.keyPackageRef !== keyPackageRef)
		);
	}
}

let lastReconciledOwnerPubkey = '';

export async function reconcilePublishedKeyPackagesForActiveAccount() {
	const account = requireActiveAccount('You must be logged in to manage key packages');
	const ownerPubkey = normalizePubKey(account.pubkey);
	const localKeyPackages = listChatKeyPackages(ownerPubkey);
	if (localKeyPackages.length === 0) {
		lastReconciledOwnerPubkey = ownerPubkey;
		return;
	}

	const coordinatorKeys = dedupeStrings(listKnownCoordinatorKeys().map(normalizePubKey));
	for (const keyPackage of localKeyPackages) {
		for (const coordinatorKey of keyPackage.publishedCoordinatorKeys) {
			const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
			if (!coordinatorKeys.includes(normalizedCoordinatorKey)) {
				coordinatorKeys.push(normalizedCoordinatorKey);
			}
		}
	}

	const availableRefsByCoordinator: Record<string, string[]> = {};
	for (const coordinatorKey of coordinatorKeys) {
		const result = await queryClient.fetchQuery({
			queryKey: chatQueryKeys.availableKeyPackages(ownerPubkey, coordinatorKey),
			queryFn: () => fetchCoordinatorAvailableKeyPackages(coordinatorKey),
			staleTime: 30 * 1000
		});
		availableRefsByCoordinator[coordinatorKey] = result
			.filter((entry) => normalizePubKey(entry.pk) === ownerPubkey)
			.map((entry) => entry.kp_ref);
	}

	await setKeyPackages(
		chatKeyPackagesStore.keyPackages.map((entry) => {
			if (normalizePubKey(entry.ownerPubkey) !== ownerPubkey) return entry;
			const publishedCoordinatorKeys = entry.publishedCoordinatorKeys.filter((coordinatorKey) =>
				(availableRefsByCoordinator[normalizePubKey(coordinatorKey)] ?? []).includes(
					entry.keyPackageRef
				)
			);
			return publishedCoordinatorKeys.length === entry.publishedCoordinatorKeys.length
				? entry
				: { ...entry, publishedCoordinatorKeys };
		})
	);
	lastReconciledOwnerPubkey = ownerPubkey;
}

export function shouldReconcilePublishedKeyPackages(ownerPubkey?: string) {
	if (!ownerPubkey) return false;
	return normalizePubKey(ownerPubkey) !== lastReconciledOwnerPubkey;
}

export async function markKeyPackagePublished(
	keyPackageRef: string,
	coordinatorKey: string,
	isLastResort?: boolean
) {
	const normalizedCoordinator = normalizePubKey(coordinatorKey);
	await setKeyPackages(
		chatKeyPackagesStore.keyPackages.map((entry) => {
			if (entry.keyPackageRef !== keyPackageRef) return entry;
			const publishedCoordinatorKeys = entry.publishedCoordinatorKeys.includes(
				normalizedCoordinator
			)
				? entry.publishedCoordinatorKeys
				: [...entry.publishedCoordinatorKeys, normalizedCoordinator];
			return {
				...entry,
				isLastResort: isLastResort ?? entry.isLastResort,
				publishedCoordinatorKeys
			};
		})
	);
	if (isLastResort) {
		// spec §10.5/§11.5: an existing key package promoted to last-resort on
		// publish must reach the meta document for cross-device Welcome coverage.
		onMetaStateChange();
	}
}

/**
 * The account's currently-published last-resort key package, for the meta
 * document (spec §4.2/§11.5). Returns undefined when the device holds none.
 * Both fields are the base64 the record already stores.
 */
export function getLastResortKeyPackageEntry(): LastResortKeyPackageEntry | undefined {
	const ownerPubkey = normalizePubKey(getActivePubkey());
	const record = chatKeyPackagesStore.keyPackages.find(
		(kp) => kp.isLastResort && kp.ownerPubkey === ownerPubkey
	);
	if (!record) return undefined;
	return {
		keyPackage: record.keyPackageBase64,
		privateKeyPackage: record.privateKeyPackageBase64
	};
}

/**
 * Load the account's last-resort key package from a meta document (spec §11.5)
 * so this device can process a Welcome built against it. Idempotent by
 * `keyPackageRef`: a package already held is not re-added. Returns true if
 * newly loaded, false if it was already present.
 */
export async function loadLastResortKeyPackage(entry: LastResortKeyPackageEntry): Promise<boolean> {
	const ownerPubkey = normalizePubKey(getActivePubkey());
	const keyPackageDecoded = keyPackageDecoder(base64ToBytes(entry.keyPackage), 0);
	if (!keyPackageDecoded) throw new Error('Unable to decode last-resort key package');
	const cipherSuite = await getCipherSuite();
	const keyPackageRef = bytesToHex(await makeKeyPackageRef(keyPackageDecoded[0], cipherSuite.hash));
	if (chatKeyPackagesStore.keyPackages.some((kp) => kp.keyPackageRef === keyPackageRef)) {
		return false; // already held
	}
	const privateKeyPackageDecoded = privateKeyPackageDecoder(
		base64ToBytes(entry.privateKeyPackage),
		0
	);
	if (!privateKeyPackageDecoded)
		throw new Error('Unable to decode last-resort private key package');
	const timestamp = Date.now();
	const record: StoredKeyPackageRecord = {
		id: `${ownerPubkey.slice(0, 8)}-lr-${timestamp}`,
		ownerPubkey,
		label: 'Last resort (replicated)',
		isLastResort: true,
		keyPackageRef,
		keyPackageBase64: entry.keyPackage,
		privateKeyPackageBase64: entry.privateKeyPackage,
		cipherSuite: CLI_CIPHERSUITE,
		createdAt: timestamp,
		publishedCoordinatorKeys: []
	};
	await setKeyPackages([record, ...chatKeyPackagesStore.keyPackages]);
	return true;
}
