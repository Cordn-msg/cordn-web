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
	type CustomExtension,
	type KeyPackage,
	type PrivateKeyPackage
} from 'ts-mls';
import { manager } from '$lib/services/accountManager.svelte';
import { cordnClient } from '$lib/services/coordinatorClient';
import { relayActions } from '$lib/stores/relay-store.svelte';
import {
	CLI_CIPHERSUITE,
	createCordnMetadataCapabilities,
	createCredential,
	getCordnCipherSuite
} from '$lib/services/chatMlsUtils';
import { getChatCoordinator, markCoordinatorUsed } from '$lib/services/chatCoordinators.svelte';
import type { IAccount } from 'applesauce-accounts';

const STORAGE_KEY = 'cordn-chat-key-packages';
const LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE = 0x0004;

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

function ensureLastResortKeyPackageExtension(extensions: CustomExtension[] = []) {
	if (
		extensions.some(
			(extension) => extension.extensionType === LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE
		)
	) {
		return extensions;
	}

	return [
		...extensions,
		{
			extensionType: LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE,
			extensionData: new Uint8Array()
		} as CustomExtension
	];
}

function isLastResortKeyPackage(keyPackage: KeyPackage): boolean {
	return keyPackage.extensions.some((extension) => {
		if (extension.extensionType !== LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE) {
			return false;
		}

		if (extension.extensionData.length !== 0) {
			throw new Error('Invalid last-resort key package extension data');
		}

		return true;
	});
}

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

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function getActivePubkey(): string {
	const account = manager.getActive();
	if (!account) {
		throw new Error('You must be logged in to create a key package');
	}
	return account.pubkey;
}

function getActiveAccount(): IAccount {
	const account = manager.getActive();
	if (!account) {
		throw new Error('You must be logged in to manage key packages');
	}
	return account;
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

	chatKeyPackagesStore.keyPackages = [record, ...chatKeyPackagesStore.keyPackages];
	saveKeyPackages();

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
	const normalizedCoordinator = coordinatorKey.trim().toLowerCase();
	const account = getActiveAccount();
	const coordinator = getChatCoordinator(normalizedCoordinator);
	const client = new cordnClient({
		signer: account.signer,
		serverPubkey: normalizedCoordinator,
		relays: coordinator?.relays ?? relayActions.getSelectedRelays()
	} as ConstructorParameters<typeof cordnClient>[0]);
	const result = await client.PublishKeyPackage({
		kp_ref: record.keyPackageRef,
		kp_64: record.keyPackageBase64
	});
	await client.disconnect();
	markCoordinatorUsed(normalizedCoordinator);
	markKeyPackagePublished(record.keyPackageRef, normalizedCoordinator, result.last_resort);
}

export function markKeyPackagePublished(
	keyPackageRef: string,
	coordinatorKey: string,
	isLastResort?: boolean
) {
	const normalizedCoordinator = coordinatorKey.trim().toLowerCase();
	chatKeyPackagesStore.keyPackages = chatKeyPackagesStore.keyPackages.map((entry) => {
		if (entry.keyPackageRef !== keyPackageRef) return entry;
		const publishedCoordinatorKeys = entry.publishedCoordinatorKeys.includes(normalizedCoordinator)
			? entry.publishedCoordinatorKeys
			: [...entry.publishedCoordinatorKeys, normalizedCoordinator];
		return {
			...entry,
			isLastResort: isLastResort ?? entry.isLastResort,
			publishedCoordinatorKeys
		};
	});
	saveKeyPackages();
}

export function markKeyPackageConsumed(keyPackageRef: string, groupId: string) {
	const consumedAt = Date.now();
	chatKeyPackagesStore.keyPackages = chatKeyPackagesStore.keyPackages.map((entry) =>
		entry.keyPackageRef === keyPackageRef
			? {
					...entry,
					consumedAt,
					consumedByGroupId: groupId
				}
			: entry
	);
	saveKeyPackages();
}
