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
import { listKnownCoordinatorKeys } from '$lib/services/chatWelcomeNotifications.svelte';
import { markCoordinatorUsed } from '$lib/services/chatCoordinators.svelte';
import { requireActiveAccount, withCoordinatorClient } from '$lib/services/chatRuntime';
import {
	getChatStorage,
	type StoredChatKeyPackageRecord as StoredBinaryChatKeyPackageRecord
} from '$lib/storage/chatStorage';
import { normalizePubKey } from '$lib/utils';
import { bytesToHex } from 'applesauce-core/helpers';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { fetchCoordinatorAvailableKeyPackages } from '$lib/queries/chatKeyPackageQueries';

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
	consumedAt?: number;
	consumedByGroupId?: string;
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
		publishedCoordinatorKeys: [...record.publishedCoordinatorKeys],
		consumedAt: record.consumedAt,
		consumedByGroupId: record.consumedByGroupId
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
		publishedCoordinatorKeys: [...record.publishedCoordinatorKeys],
		consumedAt: record.consumedAt,
		consumedByGroupId: record.consumedByGroupId
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
	const generated = await generateKeyPackage({
		credential: createCredential(ownerPubkey),
		cipherSuite,
		capabilities: createCordnMetadataCapabilities(),
		extensions: input?.isLastResort ? ensureLastResortKeyPackageExtension([]) : undefined
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
	const result = await withCoordinatorClient(account, normalizedCoordinator, (client) =>
		client.PublishKeyPackage({
			kp_ref: record.keyPackageRef,
			kp_64: record.keyPackageBase64
		})
	);
	markCoordinatorUsed(normalizedCoordinator);
	await markKeyPackagePublished(record.keyPackageRef, normalizedCoordinator, result.last_resort);
	void queryClient.invalidateQueries({
		queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, normalizedCoordinator)
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
	const shouldRemoveRemotely = !input.localOnly && !record?.consumedAt;

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
			void queryClient.invalidateQueries({
				queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, coordinatorKey)
			});
		}
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
}

export function markKeyPackageConsumed(keyPackageRef: string, groupId: string) {
	void markKeyPackageConsumedAsync(keyPackageRef, groupId);
}

async function markKeyPackageConsumedAsync(keyPackageRef: string, groupId: string) {
	const consumedAt = Date.now();
	await setKeyPackages(
		chatKeyPackagesStore.keyPackages.map((entry) =>
			entry.keyPackageRef === keyPackageRef
				? {
						...entry,
						consumedAt,
						consumedByGroupId: groupId
					}
				: entry
		)
	);
}
