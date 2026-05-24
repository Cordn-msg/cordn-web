import { SvelteMap } from 'svelte/reactivity';
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
	replaceMemberInGroup,
	removeMemberFromGroup,
	updateGroupMetadataExtension,
	SelfRemovalNotSupportedError,
	type CordnGroupMetadata
} from '$lib/services/chatMlsUtils';
import { assertCanAdministerGroup, listGroupMembers } from '$lib/services/chatAdminPolicy';
import {
	createApplicationMessageBase64,
	createDeleteMessageTags,
	createEditMessageTags,
	createReactionMessageTags,
	createReplyMessageTags,
	createUnsignedCordnMessageEvent,
	encodeAuthenticatedSender,
	type ChatMessageDeleteTarget,
	type ChatMessageEditTarget,
	type ChatMessageReactionTarget,
	type ChatMessageReplyTarget,
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
	getProtocolGroupId,
	type GroupMetadataInput
} from '$lib/services/chatGroupLifecycle.svelte';
import {
	getWelcomeNotification,
	fetchWelcomeNotifications,
	removeWelcomeNotification
} from '$lib/services/chatWelcomeNotifications.svelte';
import { normalizePubKey } from '$lib/utils';
import { getCoordinatorClient, requireActiveAccount } from '$lib/services/chatRuntime';
import { getChatStorage, type StoredChatGroupData } from '$lib/storage/chatStorage';

const groupIdDecoder = new TextDecoder();

export interface StoredChatGroup {
	id: string;
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

const groupOperationChains = new SvelteMap<string, Promise<unknown>>();
const pendingEpochOperations = createGroupPendingEpochStore();
let groupsReady: Promise<void> | null = null;
let persistGroupsPromise: Promise<void> = Promise.resolve();
let groupsLoaded = false;

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

function toStoredGroupData(group: StoredChatGroup): StoredChatGroupData {
	return {
		id: group.id,
		coordinatorKey: group.coordinatorKey,
		createdAt: group.createdAt,
		lastCursor: group.lastCursor,
		fetchCursor: group.fetchCursor,
		status: group.status,
		removedAtCursor: group.removedAtCursor,
		stateBytes: base64ToBytes(group.stateBase64),
		messages: group.messages.map((message) => ({
			...message,
			tags: message.tags.map((tag) => [...tag])
		})),
		syncIssues: group.syncIssues.map((issue) => ({ ...issue }))
	};
}

function fromStoredGroupData(group: StoredChatGroupData): StoredChatGroup {
	const decoded = clientStateDecoder(group.stateBytes, 0);
	const metadata = decoded
		? toPersistedGroupMetadata(getCordnGroupMetadataExtension(decoded[0]))
		: undefined;
	return migrateStoredGroup({
		id: group.id,
		coordinatorKey: group.coordinatorKey,
		createdAt: group.createdAt,
		stateBase64: bytesToBase64(group.stateBytes),
		lastCursor: group.lastCursor,
		fetchCursor: group.fetchCursor,
		messages: group.messages.map((message) => ({
			...message,
			tags: message.tags.map((tag) => [...tag])
		})),
		syncIssues: group.syncIssues.map((issue) => ({ ...issue })),
		status: group.status,
		removedAtCursor: group.removedAtCursor,
		metadata
	});
}

async function loadGroups() {
	const storage = await getChatStorage();
	const groups = await Promise.all(
		(await storage.listGroups()).map(async (group) => {
			const fullGroup = await storage.getGroup(group.id);
			if (!fullGroup) {
				throw new Error(`Stored group ${group.id} not found`);
			}
			return fromStoredGroupData(fullGroup);
		})
	);
	chatGroupsStore.groups = groups;
	groupsLoaded = true;
}

async function ensureGroupsLoaded() {
	groupsReady ??= loadGroups();
	await groupsReady;
}

function persistGroups(groups: StoredChatGroup[]) {
	persistGroupsPromise = persistGroupsPromise
		.then(async () => {
			const storage = await getChatStorage();
			const existingGroups = await storage.listGroups();
			const nextIds = new Set(groups.map((group) => group.id));
			for (const existing of existingGroups) {
				if (!nextIds.has(existing.id)) {
					await storage.deleteGroup(existing.id);
				}
			}
			for (const group of groups) {
				await storage.putGroup(toStoredGroupData(group));
			}
		})
		.catch(() => undefined);
	return persistGroupsPromise;
}

void ensureGroupsLoaded();

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
		throw new RemovedFromGroupError(group.metadata?.name || group.id);
	}
}

export function listChatGroups(): StoredChatGroup[] {
	return [...chatGroupsStore.groups].sort((a, b) => a.createdAt - b.createdAt);
}

export function areChatGroupsLoaded(): boolean {
	return groupsLoaded;
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
	void persistGroups(chatGroupsStore.groups);
}

function replaceGroup(groupId: string, nextGroup: StoredChatGroup) {
	chatGroupsStore.groups = chatGroupsStore.groups.map((group) =>
		group.id === groupId ? nextGroup : group
	);
	void persistGroups(chatGroupsStore.groups);
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
	requireActiveAccount('You must be logged in to create a group');
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

	const normalizedCoordinatorKey = normalizePubKey(input.coordinatorKey);
	markCoordinatorUsed(normalizedCoordinatorKey);

	const group = buildStoredChatGroup({
		id: getProtocolGroupId(state),
		coordinatorKey: normalizedCoordinatorKey,
		stateBase64: encodeState(state),
		metadata
	});

	persistGroup(group);
	return group;
}

export async function acceptChatWelcome(input: { welcomeId: string }): Promise<StoredChatGroup> {
	requireActiveAccount('You must be logged in to accept a welcome');
	const existingWelcome = getWelcomeNotification(input.welcomeId);
	if (existingWelcome) {
		await fetchWelcomeNotifications([existingWelcome.coordinatorKey]);
	}
	const welcome = getWelcomeNotification(input.welcomeId);
	if (!welcome) {
		throw new Error('Stored welcome not found');
	}

	const group = await acceptWelcomeToGroup({
		welcome,
		encodeState
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
		const replacedLeafIndex = findMemberLeafIndexByStablePubkey(
			state,
			normalizePubKey(consumeResult.keyPackage.pk)
		);

		const commitResult =
			replacedLeafIndex < 0
				? await addMemberToGroup({
						state,
						memberKeyPackage
					})
				: await replaceMemberInGroup({
						state,
						memberKeyPackage,
						removedLeafIndex: replacedLeafIndex
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
			stateBase64: encodeState(commitResult.newState),
			metadata:
				toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
				group.metadata
		};
		const result = await coordinatorClient.FetchGroupMessages({
			gid: groupIdDecoder.decode(state.groupContext.groupId),
			after: group.fetchCursor > 0 ? group.fetchCursor : undefined
		});

		const workingGroup = createWorkingChatGroupSession(syncBaseGroup, commitResult.newState);
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

export async function updateChatGroupMetadata(input: {
	groupId: string;
	name: string;
	description?: string;
	icon?: string;
	imageUrl?: string;
	adminPubkeys?: string[];
}): Promise<StoredChatGroup> {
	return runGroupOperation(input.groupId, async () => {
		const account = requireActiveAccount('You must be logged in to update group metadata');
		const group = requireChatGroup(input.groupId);
		assertChatGroupIsActive(group);
		assertCanAdministerGroup({
			groupId: group.id,
			metadata: group.metadata,
			stablePubkey: account.pubkey
		});

		const metadata: GroupMetadataInput = {
			name: input.name,
			description: input.description,
			icon: input.icon,
			imageUrl: input.imageUrl,
			adminPubkeys: input.adminPubkeys
		};
		const state = decodeStoredGroupState(group);
		const coordinatorClient = getCoordinatorClient(account, group.coordinatorKey);
		const commitResult = await updateGroupMetadataExtension({
			state,
			metadata
		});

		enqueuePendingEpochOperation(pendingEpochOperations, {
			kind: 'update-group-metadata',
			groupId: group.id,
			commitMessageBase64: commitResult.commitMessageBase64
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
						metadata
				},
				commitResult.newState
			),
			encodeState,
			metadata:
				toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ?? metadata
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
	tags?: string[][];
	replyTo?: ChatMessageReplyTarget;
	reactionTo?: ChatMessageReactionTarget;
	editTo?: ChatMessageEditTarget;
	deleteTo?: ChatMessageDeleteTarget;
}): Promise<StoredChatMessage> {
	return runGroupOperation(input.groupId, async () => {
		const account = requireActiveAccount('You must be logged in to send a message');
		const group = requireChatGroup(input.groupId);
		assertChatGroupIsActive(group);

		const isReaction = Boolean(input.reactionTo);
		const isEdit = Boolean(input.editTo);
		const isDelete = Boolean(input.deleteTo);
		const content = isReaction ? input.content : input.content.trim();
		if (!content && !isDelete) {
			throw new Error('Message content is required');
		}

		const state = decodeStoredGroupState(group);
		const coordinatorClient = getCoordinatorClient(account, group.coordinatorKey);
		const tags = input.reactionTo
			? createReactionMessageTags(input.reactionTo)
			: input.deleteTo
				? createDeleteMessageTags(input.deleteTo)
				: input.editTo
					? createEditMessageTags(input.editTo, input.tags)
					: [
							...(input.replyTo ? createReplyMessageTags(input.replyTo) : []),
							...(input.tags ?? [])
						];

		const outbound = await createApplicationMessageBase64({
			state,
			event: createUnsignedCordnMessageEvent({
				pubkey: normalizePubKey(account.pubkey),
				content,
				kind: input.reactionTo ? 7 : isEdit ? 1010 : isDelete ? 5 : input.replyTo ? 1111 : 9,
				tags
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
	void persistGroups(chatGroupsStore.groups);
}
