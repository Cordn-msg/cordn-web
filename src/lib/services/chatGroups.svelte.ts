import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import {
	bytesToBase64,
	base64ToBytes,
	clientStateDecoder,
	clientStateEncoder,
	createGroup,
	encode,
	generateKeyPackage,
	keyPackageEncoder,
	unsafeTestingAuthenticationService,
	type ClientState,
	type KeyPackage,
	type PrivateKeyPackage
} from 'ts-mls';
import { manager } from '$lib/services/accountManager.svelte';
import { relayActions } from '$lib/stores/relay-store.svelte';
import { cordnClient } from '$lib/services/coordinatorClient';
import { getChatCoordinator, markCoordinatorUsed } from '$lib/services/chatCoordinators.svelte';
import {
	createChatKeyPackage,
	decodeStoredKeyPackage,
	getChatKeyPackage,
	markKeyPackageConsumed,
	markKeyPackagePublished
} from '$lib/services/chatKeyPackages.svelte';
import {
	addMemberToGroup,
	createCordnMetadataCapabilities,
	createCredential,
	encodeWelcomeBase64,
	getCordnCipherSuite,
	getCordnGroupMetadataExtension,
	joinGroupFromWelcome,
	makeCordnGroupMetadataExtension,
	parseConsumedPublishedKeyPackage,
	type CordnGroupMetadata
} from '$lib/services/chatMlsUtils';
import {
	createApplicationMessageBase64,
	createUnsignedCordnMessageEvent,
	encodeAuthenticatedSender,
	ingestChatGroupMessages,
	type StoredChatMessage,
	type StoredChatSyncIssue
} from '$lib/services/chatGroupMessages.svelte';
import {
	getWelcomeNotification,
	removeWelcomeNotification
} from '$lib/services/chatWelcomeNotifications.svelte';
import type { IAccount } from 'applesauce-accounts';
import { normalizePubKey } from '$lib/utils';

const STORAGE_KEY = 'cordn-chat-groups';

export interface GroupMetadataInput extends CordnGroupMetadata {
	name: string;
}

export interface StoredChatGroup {
	id: string;
	alias: string;
	coordinatorKey: string;
	createdAt: number;
	stateBase64: string;
	lastCursor: number;
	fetchCursor: number;
	messages: StoredChatMessage[];
	syncIssues: StoredChatSyncIssue[];
	metadata?: GroupMetadataInput;
}

export interface CoordinatorAvailableKeyPackage {
	stablePubkey: string;
	keyPackageRef: string;
	isLastResort: boolean;
	publishedAt: number;
}

type PersistedGroups = {
	groups: StoredChatGroup[];
};

function migrateStoredGroup(group: StoredChatGroup): StoredChatGroup {
	return {
		...group,
		lastCursor: group.lastCursor ?? 0,
		fetchCursor: group.fetchCursor ?? 0,
		messages: group.messages ?? [],
		syncIssues: group.syncIssues ?? []
	};
}

export const chatGroupsStore = $state<{ groups: StoredChatGroup[] }>({
	groups: []
});

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || `group-${Date.now()}`;
}

function saveGroups() {
	if (!browser) return;
	const payload: PersistedGroups = { groups: chatGroupsStore.groups };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadGroups() {
	if (!browser) return;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedGroups;
		chatGroupsStore.groups = (parsed.groups ?? []).map(migrateStoredGroup);
	} catch {
		chatGroupsStore.groups = [];
	}
}

loadGroups();

function getActiveAccount(): IAccount {
	const account = manager.getActive();
	if (!account) {
		throw new Error('You must be logged in to create a group');
	}
	return account;
}

async function getCipherSuite() {
	return getCordnCipherSuite();
}

async function createMemberArtifacts(stablePubkey: string): Promise<{
	keyPackage: KeyPackage;
	privateKeyPackage: PrivateKeyPackage;
	keyPackageRef: string;
	keyPackageBase64: string;
}> {
	const cipherSuite = await getCipherSuite();
	const generated = await generateKeyPackage({
		credential: createCredential(stablePubkey),
		cipherSuite,
		capabilities: createCordnMetadataCapabilities()
	});

	const { makeKeyPackageRef } = await import('ts-mls');
	const keyPackageRef = bytesToHex(
		await makeKeyPackageRef(generated.publicPackage, cipherSuite.hash)
	);

	return {
		keyPackage: generated.publicPackage,
		privateKeyPackage: generated.privatePackage,
		keyPackageRef,
		keyPackageBase64: bytesToBase64(encode(keyPackageEncoder, generated.publicPackage))
	};
}

function encodeState(state: ClientState): string {
	return bytesToBase64(encode(clientStateEncoder, state));
}

export function decodeStoredGroupState(group: StoredChatGroup): ClientState {
	const decoded = clientStateDecoder(base64ToBytes(group.stateBase64), 0);
	if (!decoded) {
		throw new Error(`Unable to decode stored group state for ${group.id}`);
	}
	return decoded[0];
}

export function listChatGroups(): StoredChatGroup[] {
	return [...chatGroupsStore.groups].sort((a, b) => a.createdAt - b.createdAt);
}

export function getChatGroup(groupId: string): StoredChatGroup | undefined {
	return chatGroupsStore.groups.find((group) => group.id === groupId);
}

function buildCoordinatorClient(account: IAccount, coordinatorKey: string) {
	const coordinator = getChatCoordinator(coordinatorKey);
	return new cordnClient({
		signer: account.signer,
		serverPubkey: coordinatorKey,
		relays: coordinator?.relays ?? relayActions.getSelectedRelays()
	} as ConstructorParameters<typeof cordnClient>[0]);
}

function buildUniqueGroupId(aliasBase: string): string {
	let id = aliasBase;
	let suffix = 2;
	while (chatGroupsStore.groups.some((group) => group.id === id)) {
		id = `${aliasBase}-${suffix++}`;
	}
	return id;
}

function persistGroup(group: StoredChatGroup) {
	chatGroupsStore.groups = [...chatGroupsStore.groups, group];
	saveGroups();
}

function replaceGroup(groupId: string, nextGroup: StoredChatGroup) {
	chatGroupsStore.groups = chatGroupsStore.groups.map((group) =>
		group.id === groupId ? nextGroup : group
	);
	saveGroups();
}

function toPersistedGroupMetadata(metadata?: CordnGroupMetadata): GroupMetadataInput | undefined {
	if (!metadata) return undefined;
	return {
		name: metadata.name,
		description: metadata.description,
		icon: metadata.icon,
		imageUrl: metadata.imageUrl,
		adminPubkeys: metadata.adminPubkeys
	};
}

export async function createChatGroup(input: {
	name: string;
	description?: string;
	icon?: string;
	imageUrl?: string;
	adminPubkeys?: string[];
	coordinatorKey: string;
	keyPackageRef?: string;
	keyPackageLabel?: string;
	keyPackageIsLastResort?: boolean;
}) {
	const account = getActiveAccount();
	const metadata: GroupMetadataInput = {
		name: input.name,
		description: input.description,
		icon: input.icon,
		imageUrl: input.imageUrl,
		adminPubkeys: input.adminPubkeys
	};
	let memberArtifacts: Awaited<ReturnType<typeof createMemberArtifacts>>;
	if (input.keyPackageRef) {
		const storedRecord = getChatKeyPackage(input.keyPackageRef);
		if (!storedRecord) {
			throw new Error('Selected key package was not found');
		}
		const decoded = decodeStoredKeyPackage(storedRecord);
		memberArtifacts = {
			keyPackage: decoded.keyPackage,
			privateKeyPackage: decoded.privateKeyPackage,
			keyPackageRef: storedRecord.keyPackageRef,
			keyPackageBase64: storedRecord.keyPackageBase64
		};
	} else {
		const createdKeyPackage = await createChatKeyPackage({
			label: input.keyPackageLabel,
			isLastResort: input.keyPackageIsLastResort,
			publishCoordinatorKey: undefined
		});
		memberArtifacts = {
			keyPackage: createdKeyPackage.keyPackage,
			privateKeyPackage: createdKeyPackage.privateKeyPackage,
			keyPackageRef: createdKeyPackage.record.keyPackageRef,
			keyPackageBase64: createdKeyPackage.record.keyPackageBase64
		};
	}
	const cipherSuite = await getCipherSuite();
	const extensions = [makeCordnGroupMetadataExtension(metadata)];
	const state = await createGroup({
		context: { cipherSuite, authService: unsafeTestingAuthenticationService },
		groupId: new TextEncoder().encode(crypto.randomUUID()),
		keyPackage: memberArtifacts.keyPackage,
		privateKeyPackage: memberArtifacts.privateKeyPackage,
		extensions
	});

	const coordinatorClient = buildCoordinatorClient(account, input.coordinatorKey.trim());
	await coordinatorClient.PublishKeyPackage({
		kp_ref: memberArtifacts.keyPackageRef,
		kp_64: memberArtifacts.keyPackageBase64
	});
	await coordinatorClient.disconnect();
	markCoordinatorUsed(input.coordinatorKey.trim());
	markKeyPackagePublished(memberArtifacts.keyPackageRef, input.coordinatorKey.trim());

	const alias = slugify(input.name);
	const id = buildUniqueGroupId(alias);

	const group: StoredChatGroup = {
		id,
		alias,
		coordinatorKey: input.coordinatorKey.trim(),
		createdAt: Date.now(),
		stateBase64: encodeState(state),
		lastCursor: 0,
		fetchCursor: 0,
		messages: [],
		syncIssues: [],
		metadata
	};

	persistGroup(group);
	await goto(`/chat/${group.id}`);
	return group;
}

export async function acceptChatWelcome(input: {
	welcomeId: string;
	navigate?: boolean;
}): Promise<StoredChatGroup> {
	getActiveAccount();
	const welcome = getWelcomeNotification(input.welcomeId);
	if (!welcome) {
		throw new Error('Stored welcome not found');
	}

	const keyPackageRecord = getChatKeyPackage(welcome.kpRef);
	if (!keyPackageRecord) {
		throw new Error(`Missing local key package for welcome ${welcome.kpRef}`);
	}
	if (keyPackageRecord.consumedAt) {
		throw new Error(`Key package ${welcome.kpRef} was already consumed`);
	}

	const { keyPackage, privateKeyPackage } = decodeStoredKeyPackage(keyPackageRecord);
	const state = await joinGroupFromWelcome({
		welcomeBase64: welcome.welcomeBase64,
		keyPackage,
		privateKeyPackage
	});

	const metadata = toPersistedGroupMetadata(getCordnGroupMetadataExtension(state));
	const alias = slugify(metadata?.name || `group-${welcome.kpRef.slice(0, 8)}`);
	const id = buildUniqueGroupId(alias);
	const group: StoredChatGroup = {
		id,
		alias,
		coordinatorKey: normalizePubKey(welcome.coordinatorKey),
		createdAt: Date.now(),
		stateBase64: encodeState(state),
		lastCursor: 0,
		fetchCursor: 0,
		messages: [],
		syncIssues: [],
		metadata
	};

	persistGroup(group);
	markCoordinatorUsed(group.coordinatorKey);
	markKeyPackageConsumed(welcome.kpRef, group.id);
	removeWelcomeNotification(welcome.id);

	if (input.navigate ?? true) {
		await goto(`/chat/${group.id}`);
	}

	return group;
}

export async function listCoordinatorAvailableKeyPackages(
	groupId: string
): Promise<CoordinatorAvailableKeyPackage[]> {
	const account = getActiveAccount();
	const group = getChatGroup(groupId);
	if (!group) {
		throw new Error('Group not found');
	}

	const coordinatorClient = buildCoordinatorClient(account, group.coordinatorKey);
	try {
		const result = await coordinatorClient.ListAvailableKeyPackages();
		return result.keyPackages
			.filter((entry) => normalizePubKey(entry.pk) !== normalizePubKey(account.pubkey))
			.map((entry) => ({
				stablePubkey: normalizePubKey(entry.pk),
				keyPackageRef: entry.kp_ref,
				isLastResort: entry.last_resort,
				publishedAt: entry.at
			}))
			.sort((a, b) => b.publishedAt - a.publishedAt);
	} finally {
		await coordinatorClient.disconnect();
	}
}

export async function inviteChatGroupMember(input: {
	groupId: string;
	identifier: string;
}): Promise<StoredChatGroup> {
	const account = getActiveAccount();
	const group = getChatGroup(input.groupId);
	if (!group) {
		throw new Error('Group not found');
	}

	const state = decodeStoredGroupState(group);
	const coordinatorClient = buildCoordinatorClient(account, group.coordinatorKey);

	try {
		const consumeResult = await coordinatorClient.ConsumeKeyPackage({
			id: input.identifier.trim()
		});

		if (!consumeResult.keyPackage) {
			throw new Error(`No published key package found for ${input.identifier}`);
		}

		const memberKeyPackage = await parseConsumedPublishedKeyPackage({
			stablePubkey: normalizePubKey(consumeResult.keyPackage.pk),
			publicationEvent: consumeResult.keyPackage.event
		});

		const commitResult = await addMemberToGroup({
			state,
			memberKeyPackage
		});

		await coordinatorClient.PostGroupMessage({
			msg_64: commitResult.commitMessageBase64
		});

		await coordinatorClient.StoreWelcome({
			target_pk: normalizePubKey(consumeResult.keyPackage.pk),
			kp_ref: consumeResult.keyPackage.kp_ref,
			welcome_64: encodeWelcomeBase64(commitResult.welcome)
		});

		const metadata =
			toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
			group.metadata;
		const nextGroup: StoredChatGroup = {
			...group,
			stateBase64: encodeState(commitResult.newState),
			metadata
		};

		replaceGroup(group.id, nextGroup);
		return nextGroup;
	} finally {
		await coordinatorClient.disconnect();
	}
}

export function listChatGroupMessages(groupId: string): StoredChatMessage[] {
	const group = getChatGroup(groupId);
	return group ? [...group.messages].sort((a, b) => a.cursor - b.cursor) : [];
}

export function listChatGroupSyncIssues(groupId: string): StoredChatSyncIssue[] {
	const group = getChatGroup(groupId);
	return group ? [...group.syncIssues].sort((a, b) => a.cursor - b.cursor) : [];
}

export async function fetchChatGroupMessages(groupId: string): Promise<{
	group: StoredChatGroup;
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
}> {
	const account = getActiveAccount();
	const group = getChatGroup(groupId);
	if (!group) {
		throw new Error('Group not found');
	}

	const state = decodeStoredGroupState(group);
	const coordinatorClient = buildCoordinatorClient(account, group.coordinatorKey);

	try {
		const groupIdBytes = state.groupContext.groupId;
		const gid = new TextDecoder().decode(groupIdBytes);
		const result = await coordinatorClient.FetchGroupMessages({
			gid,
			after: group.fetchCursor > 0 ? group.fetchCursor : undefined
		});

		const workingGroup = {
			state,
			metadata: group.metadata,
			lastCursor: group.lastCursor,
			fetchCursor: group.fetchCursor,
			messages: [...group.messages],
			syncIssues: [...group.syncIssues]
		};

		const sync = await ingestChatGroupMessages({
			group: workingGroup,
			messages: result.messages.map((message) => ({
				cursor: message.cursor,
				createdAt: message.at,
				opaqueMessageBase64: message.msg_64
			}))
		});

		const nextGroup: StoredChatGroup = {
			...group,
			stateBase64: encodeState(workingGroup.state),
			metadata: toPersistedGroupMetadata(workingGroup.metadata) ?? group.metadata,
			lastCursor: workingGroup.lastCursor,
			fetchCursor: workingGroup.fetchCursor,
			messages: workingGroup.messages,
			syncIssues: workingGroup.syncIssues
		};

		replaceGroup(group.id, nextGroup);
		return {
			group: nextGroup,
			received: sync.received,
			issues: sync.issues
		};
	} finally {
		await coordinatorClient.disconnect();
	}
}

export async function sendChatGroupMessage(input: {
	groupId: string;
	content: string;
}): Promise<StoredChatMessage> {
	const account = getActiveAccount();
	const group = getChatGroup(input.groupId);
	if (!group) {
		throw new Error('Group not found');
	}

	const content = input.content.trim();
	if (!content) {
		throw new Error('Message content is required');
	}

	const state = decodeStoredGroupState(group);
	const coordinatorClient = buildCoordinatorClient(account, group.coordinatorKey);

	try {
		const outbound = await createApplicationMessageBase64({
			state,
			event: createUnsignedCordnMessageEvent({
				pubkey: normalizePubKey(account.pubkey),
				content
			}),
			authenticatedData: encodeAuthenticatedSender(normalizePubKey(account.pubkey))
		});

		const posted = await coordinatorClient.PostGroupMessage({
			msg_64: outbound.opaqueMessageBase64
		});

		const stored: StoredChatMessage = {
			cursor: posted.cursor,
			createdAt: posted.at,
			direction: 'outbound',
			sender: normalizePubKey(account.pubkey),
			id: outbound.event.id,
			kind: outbound.event.kind,
			tags: outbound.event.tags,
			content: outbound.event.content
		};

		const nextGroup: StoredChatGroup = {
			...group,
			stateBase64: encodeState(outbound.newState),
			lastCursor: Math.max(group.lastCursor, posted.cursor),
			messages: [...group.messages, stored]
		};

		replaceGroup(group.id, nextGroup);
		return stored;
	} finally {
		await coordinatorClient.disconnect();
	}
}
