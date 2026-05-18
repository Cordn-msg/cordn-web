import { browser } from '$app/environment';
import {
	bytesToBase64,
	base64ToBytes,
	clientStateDecoder,
	clientStateEncoder,
	encode,
	type ClientState
} from 'ts-mls';
import { markCoordinatorUsed } from '$lib/services/chatCoordinators.svelte';
import { createChatKeyPackage } from '$lib/services/chatKeyPackages.svelte';
import {
	addMemberToGroup,
	encodeWelcomeBase64,
	findMemberLeafIndexByStablePubkey,
	getCordnGroupMetadataExtension,
	parseConsumedPublishedKeyPackage,
	removeMemberFromGroup,
	SelfRemovalNotSupportedError,
	type CordnGroupMetadata
} from '$lib/services/chatMlsUtils';
import { assertCanAdministerGroup, listGroupMembers } from '$lib/services/chatAdminPolicy';
import {
	createApplicationMessageBase64,
	createUnsignedCordnMessageEvent,
	encodeAuthenticatedSender,
	type StoredChatMessage,
	type StoredChatSyncIssue
} from '$lib/services/chatGroupMessages.svelte';
import {
	createGroupPendingEpochStore,
	enqueuePendingEpochOperation
} from '$lib/services/chatGroupProtocol';
import {
	buildPersistedChatGroup,
	createWorkingChatGroupSession,
	syncChatGroupMessages
} from '$lib/services/chatGroupSessions.svelte';
import {
	acceptWelcomeToGroup,
	buildStoredChatGroup,
	createInitialGroupState,
	createMemberArtifacts,
	markGroupCreatorKeyPackagePublished,
	type GroupMetadataInput
} from '$lib/services/chatGroupLifecycle.svelte';
import {
	getWelcomeNotification,
	removeWelcomeNotification
} from '$lib/services/chatWelcomeNotifications.svelte';
import { buildUniqueSlugId, normalizePubKey } from '$lib/utils';
import { getCoordinatorClient, requireActiveAccount } from '$lib/services/chatRuntime';

const STORAGE_KEY = 'cordn-chat-groups';
const groupIdDecoder = new TextDecoder();

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
	status?: 'active' | 'removed';
	removedAtCursor?: number;
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

const groupOperationChains = new Map<string, Promise<unknown>>();
const pendingEpochOperations = createGroupPendingEpochStore();

function migrateStoredGroup(group: StoredChatGroup): StoredChatGroup {
	return {
		...group,
		lastCursor: group.lastCursor ?? 0,
		fetchCursor: group.fetchCursor ?? 0,
		messages: group.messages ?? [],
		syncIssues: group.syncIssues ?? [],
		status: group.status ?? 'active',
		removedAtCursor: group.removedAtCursor
	};
}

export const chatGroupsStore = $state<{ groups: StoredChatGroup[] }>({
	groups: []
});

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

export class RemovedFromGroupError extends Error {
	constructor(groupId: string) {
		super(`You were removed from this group and can no longer participate: ${groupId}`);
		this.name = 'RemovedFromGroupError';
	}
}

export function isChatGroupRemoved(group: StoredChatGroup | undefined): boolean {
	if (!group) return false;
	if (group.status === 'removed') return true;
	try {
		return decodeStoredGroupState(group).groupActiveState?.kind === 'removedFromGroup';
	} catch {
		return false;
	}
}

function assertChatGroupIsActive(group: StoredChatGroup): void {
	if (isChatGroupRemoved(group)) {
		throw new RemovedFromGroupError(group.alias || group.id);
	}
}

export function listChatGroups(): StoredChatGroup[] {
	return [...chatGroupsStore.groups].sort((a, b) => a.createdAt - b.createdAt);
}

export function getChatGroup(groupId: string): StoredChatGroup | undefined {
	return chatGroupsStore.groups.find((group) => group.id === groupId);
}

function requireChatGroup(groupId: string): StoredChatGroup {
	const group = getChatGroup(groupId);
	if (!group) {
		throw new Error('Group not found');
	}

	return group;
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

async function runGroupOperation<T>(groupId: string, operation: () => Promise<T>): Promise<T> {
	const previous = groupOperationChains.get(groupId) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	groupOperationChains.set(
		groupId,
		previous.then(() => current)
	);

	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (groupOperationChains.get(groupId) === current) {
			groupOperationChains.delete(groupId);
		}
	}
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
	const account = requireActiveAccount('You must be logged in to create a group');
	const metadata: GroupMetadataInput = {
		name: input.name,
		description: input.description,
		icon: input.icon,
		imageUrl: input.imageUrl,
		adminPubkeys: input.adminPubkeys
	};
	const memberArtifacts = await createMemberArtifacts({
		selectedKeyPackageRef: input.keyPackageRef,
		createKeyPackage: async () =>
			createChatKeyPackage({
				label: input.keyPackageLabel,
				isLastResort: input.keyPackageIsLastResort,
				publishCoordinatorKey: undefined
			})
	});
	const state = await createInitialGroupState({
		metadata,
		memberArtifacts
	});

	const coordinatorClient = getCoordinatorClient(account, input.coordinatorKey);
	await coordinatorClient.PublishKeyPackage({
		kp_ref: memberArtifacts.keyPackageRef,
		kp_64: memberArtifacts.keyPackageBase64
	});
	const normalizedCoordinatorKey = normalizePubKey(input.coordinatorKey);
	markCoordinatorUsed(normalizedCoordinatorKey);
	markGroupCreatorKeyPackagePublished(memberArtifacts.keyPackageRef, normalizedCoordinatorKey);

	const group = buildStoredChatGroup({
		id: buildUniqueSlugId(
			chatGroupsStore.groups.map((group) => group.id),
			input.name,
			`group-${Date.now()}`
		),
		coordinatorKey: normalizedCoordinatorKey,
		stateBase64: encodeState(state),
		metadata
	});

	persistGroup(group);
	return group;
}

export async function acceptChatWelcome(input: { welcomeId: string }): Promise<StoredChatGroup> {
	requireActiveAccount('You must be logged in to accept a welcome');
	const welcome = getWelcomeNotification(input.welcomeId);
	if (!welcome) {
		throw new Error('Stored welcome not found');
	}

	const group = await acceptWelcomeToGroup({
		welcome,
		encodeState,
		buildGroupId: (name, fallback) =>
			buildUniqueSlugId(
				chatGroupsStore.groups.map((group) => group.id),
				name,
				fallback
			)
	});
	group.coordinatorKey = normalizePubKey(group.coordinatorKey);
	group.metadata = toPersistedGroupMetadata(group.metadata);

	persistGroup(group);
	markCoordinatorUsed(group.coordinatorKey);
	removeWelcomeNotification(welcome.id);

	return group;
}

export async function listCoordinatorAvailableKeyPackages(
	groupId: string
): Promise<CoordinatorAvailableKeyPackage[]> {
	const account = requireActiveAccount('You must be logged in to list coordinator key packages');
	const group = getChatGroup(groupId);
	if (!group) {
		throw new Error('Group not found');
	}

	const coordinatorClient = getCoordinatorClient(account, group.coordinatorKey);
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
}

export async function inviteChatGroupMember(input: {
	groupId: string;
	identifier: string;
}): Promise<StoredChatGroup> {
	return runGroupOperation(input.groupId, async () => {
		const account = requireActiveAccount('You must be logged in to invite a member');
		const group = requireChatGroup(input.groupId);
		assertChatGroupIsActive(group);
		assertCanAdministerGroup({
			groupId: group.id,
			metadata: group.metadata,
			stablePubkey: account.pubkey
		});

		const state = decodeStoredGroupState(group);
		const coordinatorClient = getCoordinatorClient(account, group.coordinatorKey);

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

		enqueuePendingEpochOperation(pendingEpochOperations, {
			kind: 'add-member',
			groupId: group.id,
			commitMessageBase64: commitResult.commitMessageBase64,
			targetStablePubkey: normalizePubKey(consumeResult.keyPackage.pk),
			keyPackageReference: consumeResult.keyPackage.kp_ref,
			welcomeBase64: encodeWelcomeBase64(commitResult.welcome)
		});

		await coordinatorClient.PostGroupMessage({
			msg_64: commitResult.commitMessageBase64
		});

		const syncBaseGroup: StoredChatGroup = {
			...group,
			metadata:
				toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
				group.metadata
		};
		const result = await coordinatorClient.FetchGroupMessages({
			gid: groupIdDecoder.decode(state.groupContext.groupId),
			after: group.fetchCursor > 0 ? group.fetchCursor : undefined
		});

		const workingGroup = createWorkingChatGroupSession(syncBaseGroup, state);
		const sync = await syncChatGroupMessages({
			group,
			workingGroup,
			messages: result.messages.map((message) => ({
				cursor: message.cursor,
				createdAt: message.at,
				opaqueMessageBase64: message.msg_64
			})),
			pendingEpochOperations,
			coordinatorClient,
			localStablePubkey: normalizePubKey(account.pubkey)
		});

		const nextGroup = buildPersistedChatGroup({
			group: syncBaseGroup,
			workingGroup: sync.workingGroup,
			encodeState,
			metadata: toPersistedGroupMetadata(sync.workingGroup.metadata)
		});

		replaceGroup(group.id, nextGroup);
		return nextGroup;
	});
}

export function listChatGroupMembers(groupId: string): Array<{
	leafIndex: number;
	stablePubkey: string;
	isAdmin: boolean;
	isSelf: boolean;
}> {
	const group = requireChatGroup(groupId);
	const state = decodeStoredGroupState(group);
	const account = requireActiveAccount('You must be logged in to inspect group members');
	return listGroupMembers(state).map((member) => ({
		...member,
		isAdmin: assertMemberAdmin(group, member.stablePubkey),
		isSelf: normalizePubKey(member.stablePubkey) === normalizePubKey(account.pubkey)
	}));
}

function assertMemberAdmin(group: StoredChatGroup, stablePubkey: string): boolean {
	return (
		group.metadata?.adminPubkeys?.length === 0 ||
		!group.metadata?.adminPubkeys ||
		group.metadata.adminPubkeys.map(normalizePubKey).includes(normalizePubKey(stablePubkey))
	);
}

export async function removeChatGroupMember(input: {
	groupId: string;
	targetStablePubkey: string;
}): Promise<StoredChatGroup> {
	return runGroupOperation(input.groupId, async () => {
		const account = requireActiveAccount('You must be logged in to remove a member');
		const group = requireChatGroup(input.groupId);
		assertChatGroupIsActive(group);
		assertCanAdministerGroup({
			groupId: group.id,
			metadata: group.metadata,
			stablePubkey: account.pubkey
		});

		if (normalizePubKey(input.targetStablePubkey) === normalizePubKey(account.pubkey)) {
			throw new SelfRemovalNotSupportedError(group.id);
		}

		const state = decodeStoredGroupState(group);
		const removedLeafIndex = findMemberLeafIndexByStablePubkey(
			state,
			normalizePubKey(input.targetStablePubkey)
		);
		if (removedLeafIndex < 0) {
			throw new Error('Member not found in group');
		}

		const coordinatorClient = getCoordinatorClient(account, group.coordinatorKey);
		const commitResult = await removeMemberFromGroup({ state, removedLeafIndex });

		enqueuePendingEpochOperation(pendingEpochOperations, {
			kind: 'remove-member',
			groupId: group.id,
			commitMessageBase64: commitResult.commitMessageBase64,
			targetStablePubkey: normalizePubKey(input.targetStablePubkey)
		});

		await coordinatorClient.PostGroupMessage({
			msg_64: commitResult.commitMessageBase64
		});

		const nextGroup = buildPersistedChatGroup({
			group,
			workingGroup: createWorkingChatGroupSession(
				{
					...group,
					metadata:
						toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
						group.metadata
				},
				commitResult.newState
			),
			encodeState,
			metadata:
				toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
				group.metadata
		});

		replaceGroup(group.id, nextGroup);
		return nextGroup;
	});
}

export function listChatGroupMessages(groupId: string): StoredChatMessage[] {
	const group = getChatGroup(groupId);
	return group ? [...group.messages].sort((a, b) => a.cursor - b.cursor) : [];
}

export function listChatGroupSyncIssues(groupId: string): StoredChatSyncIssue[] {
	const group = getChatGroup(groupId);
	return group ? [...group.syncIssues].sort((a, b) => a.cursor - b.cursor) : [];
}

async function applyIncomingChatGroupMessages(
	group: StoredChatGroup,
	messages: Array<{
		cursor: number;
		createdAt: number;
		opaqueMessageBase64: string;
	}>
): Promise<{
	group: StoredChatGroup;
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
}> {
	const account = requireActiveAccount('You must be logged in to process group messages');
	assertChatGroupIsActive(group);
	const state = decodeStoredGroupState(group);
	const coordinatorClient = getCoordinatorClient(account, group.coordinatorKey);
	const workingGroup = createWorkingChatGroupSession(group, state);

	const sync = await syncChatGroupMessages({
		group,
		workingGroup,
		messages,
		pendingEpochOperations,
		coordinatorClient,
		localStablePubkey: normalizePubKey(account.pubkey)
	});

	const nextGroup = buildPersistedChatGroup({
		group,
		workingGroup,
		encodeState,
		metadata: toPersistedGroupMetadata(workingGroup.metadata)
	});

	replaceGroup(group.id, nextGroup);
	return {
		group: nextGroup,
		received: sync.received,
		issues: sync.issues
	};
}

export async function fetchChatGroupMessages(groupId: string): Promise<{
	group: StoredChatGroup;
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
}> {
	return runGroupOperation(groupId, async () => {
		const account = requireActiveAccount('You must be logged in to fetch group messages');
		const group = requireChatGroup(groupId);
		assertChatGroupIsActive(group);

		const state = decodeStoredGroupState(group);
		const coordinatorClient = getCoordinatorClient(account, group.coordinatorKey);

		const gid = groupIdDecoder.decode(state.groupContext.groupId);
		const result = await coordinatorClient.FetchGroupMessages({
			gid,
			after: group.fetchCursor > 0 ? group.fetchCursor : undefined
		});

		return applyIncomingChatGroupMessages(
			group,
			result.messages.map((message) => ({
				cursor: message.cursor,
				createdAt: message.at,
				opaqueMessageBase64: message.msg_64
			}))
		);
	});
}

export async function ingestIncomingChatGroupMessages(
	groupId: string,
	messages: Array<{
		cursor: number;
		createdAt: number;
		opaqueMessageBase64: string;
	}>
): Promise<{
	group: StoredChatGroup;
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
}> {
	return runGroupOperation(groupId, async () => {
		const group = requireChatGroup(groupId);
		return applyIncomingChatGroupMessages(group, messages);
	});
}

export async function sendChatGroupMessage(input: {
	groupId: string;
	content: string;
}): Promise<StoredChatMessage> {
	return runGroupOperation(input.groupId, async () => {
		const account = requireActiveAccount('You must be logged in to send a message');
		const group = requireChatGroup(input.groupId);
		assertChatGroupIsActive(group);

		const content = input.content.trim();
		if (!content) {
			throw new Error('Message content is required');
		}

		const state = decodeStoredGroupState(group);
		const coordinatorClient = getCoordinatorClient(account, group.coordinatorKey);

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
			opaqueMessageBase64: outbound.opaqueMessageBase64,
			sender: normalizePubKey(account.pubkey),
			id: outbound.event.id,
			kind: outbound.event.kind,
			tags: outbound.event.tags,
			content: outbound.event.content
		};

		const workingGroup = createWorkingChatGroupSession(group, outbound.newState);
		workingGroup.lastCursor = Math.max(workingGroup.lastCursor, posted.cursor);
		workingGroup.messages.push(stored);

		const nextGroup = buildPersistedChatGroup({
			group,
			workingGroup,
			encodeState
		});

		replaceGroup(group.id, nextGroup);
		return stored;
	});
}

export function deleteChatGroup(groupId: string): void {
	chatGroupsStore.groups = chatGroupsStore.groups.filter((group) => group.id !== groupId);
	saveGroups();
}
