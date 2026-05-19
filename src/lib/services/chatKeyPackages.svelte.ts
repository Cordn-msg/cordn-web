import { browser } from '$app/environment';
import {
	bytesToBase64,
	base64ToBytes,
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
import { getCoordinatorClient, requireActiveAccount } from '$lib/services/chatRuntime';
import { normalizePubKey } from '$lib/utils';
import { bytesToHex } from 'applesauce-core/helpers';

const STORAGE_KEY = 'cordn-chat-key-packages';
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

type PersistedKeyPackages = {
	keyPackages: StoredKeyPackageRecord[];
};

export const chatKeyPackagesStore = $state<{ keyPackages: StoredKeyPackageRecord[] }>({
	keyPackages: []
});

function saveKeyPackages() {
	if (!browser) return;
	const payload: PersistedKeyPackages = { keyPackages: chatKeyPackagesStore.keyPackages };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadKeyPackages() {
	if (!browser) return;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedKeyPackages;
		chatKeyPackagesStore.keyPackages = parsed.keyPackages ?? [];
	} catch {
		chatKeyPackagesStore.keyPackages = [];
	}
}

function getActivePubkey(): string {
	return requireActiveAccount('You must be logged in to create a key package').pubkey;
}

async function getCipherSuite() {
	return getCordnCipherSuite();
}

loadKeyPackages();

export function listChatKeyPackages(ownerPubkey?: string): StoredKeyPackageRecord[] {
	const filtered = ownerPubkey
		? chatKeyPackagesStore.keyPackages.filter((entry) => entry.ownerPubkey === ownerPubkey)
		: chatKeyPackagesStore.keyPackages;
	return [...filtered].sort((a, b) => b.createdAt - a.createdAt);
}

export function getChatKeyPackage(keyPackageRef: string): StoredKeyPackageRecord | undefined {
	return chatKeyPackagesStore.keyPackages.find((entry) => entry.keyPackageRef === keyPackageRef);
}

function setKeyPackages(keyPackages: StoredKeyPackageRecord[]) {
	chatKeyPackagesStore.keyPackages = keyPackages;
	saveKeyPackages();
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

	setKeyPackages([record, ...chatKeyPackagesStore.keyPackages]);

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
	const client = getCoordinatorClient(account, normalizedCoordinator);
	const result = await client.PublishKeyPackage({
		kp_ref: record.keyPackageRef,
		kp_64: record.keyPackageBase64
	});
	markCoordinatorUsed(normalizedCoordinator);
	markKeyPackagePublished(record.keyPackageRef, normalizedCoordinator, result.last_resort);
}

export async function removeChatKeyPackage(
	keyPackageRef: string,
	input: { coordinatorKey?: string; localOnly?: boolean } = {}
) {
	const record = getChatKeyPackage(keyPackageRef);
	const normalizedCoordinator = input.coordinatorKey?.trim()
		? normalizePubKey(input.coordinatorKey)
		: undefined;

	if (!record && !normalizedCoordinator) {
		throw new Error('Key package not found');
	}

	if (!input.localOnly) {
		const account = requireActiveAccount('You must be logged in to manage key packages');
		const coordinatorKeys = normalizedCoordinator
			? [normalizedCoordinator]
			: dedupeStrings(record?.publishedCoordinatorKeys ?? []);

		for (const coordinatorKey of coordinatorKeys) {
			const client = getCoordinatorClient(account, coordinatorKey);
			await client.RemoveKeyPackages({ kp_refs: [keyPackageRef] });
		}
	}

	if (record) {
		if (normalizedCoordinator && !input.localOnly) {
			setKeyPackages(
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

		setKeyPackages(
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
		const client = getCoordinatorClient(account, coordinatorKey);
		const result = await client.ListAvailableKeyPackages({});
		availableRefsByCoordinator[coordinatorKey] = result.keyPackages
			.filter((entry) => normalizePubKey(entry.pk) === ownerPubkey)
			.map((entry) => entry.kp_ref);
	}

	setKeyPackages(
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

export function markKeyPackagePublished(
	keyPackageRef: string,
	coordinatorKey: string,
	isLastResort?: boolean
) {
	const normalizedCoordinator = normalizePubKey(coordinatorKey);
	setKeyPackages(
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
	const consumedAt = Date.now();
	setKeyPackages(
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
