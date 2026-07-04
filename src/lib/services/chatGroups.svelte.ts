import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	bytesToBase64,
	base64ToBytes,
	clientStateDecoder,
	clientStateEncoder,
	encode,
	type ClientState
} from 'ts-mls';
import { markCoordinatorUsed } from '$lib/services/chatCoordinators.svelte';
import { onLocalStateAdvance } from '$lib/services/multiDevice.svelte';
import { createChatKeyPackage, pruneZombieKeyPackages } from '$lib/services/chatKeyPackages.svelte';
import {
	addMemberToGroup,
	encodeWelcomeBase64,
	findMemberLeafIndexByStablePubkey,
	getCordnGroupMetadataExtension,
	parseConsumedPublishedKeyPackage,
	removeMemberFromGroup,
	updateGroupMetadataExtension,
	SelfRemovalNotSupportedError,
	type CordnGroupMetadata
} from '$lib/services/chatMlsUtils';
import { assertCanAdministerGroup, listGroupMembers } from '$lib/services/chatAdminPolicy';
import {
	createApplicationMessageBase64,
	createSystemMessagesFromStateChange,
	createUnsignedCordnMessageEvent,
	encodeAuthenticatedSender,
	encryptGroupPayloadBase64,
	type StoredChatMessage,
	type StoredChatSyncIssue
} from '$lib/services/chatGroupMessages.svelte';
import { findImetaTag, deriveMediaKey } from '$lib/services/chatMediaCrypto';
import {
	resolveOutboundMessage,
	type ChatMessageReplyTarget,
	type MessageTarget,
	type PinOp
} from '$lib/chat/references';
import {
	createGroupPendingEpochStore,
	enqueuePendingEpochOperation,
	type PendingEpochOperation
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
	markWelcomeAccepted
} from '$lib/services/chatWelcomeNotifications.svelte';
import { removeSentJoinRequest } from '$lib/services/chatJoinRequests.svelte';
import { normalizePubKey } from '$lib/utils';
import { manager } from '$lib/services/accountManager.svelte';
import {
	getCoordinatorClient,
	requireActiveAccount,
	withCoordinatorClient
} from '$lib/services/chatRuntime';
import {
	getChatStorage,
	type ChatStorage,
	type StoredChatGroupData
} from '$lib/storage/chatStorage';
import { fetchCoordinatorAvailableKeyPackages } from '$lib/queries/chatKeyPackageQueries';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { isGroupActivelyWatched } from '$lib/services/chatGroupWatchStatus.svelte';
import {
	createOutboundTentativeSnapshot,
	getNewestHealthySnapshot,
	promoteTentativeSnapshot,
	replaceTentativeSnapshot,
	type ChatGroupStateSnapshot
} from '$lib/services/chatGroupSnapshots';

const groupIdDecoder = new TextDecoder();

export interface StoredChatGroup {
	id: string;
	ownerPubkey?: string;
	coordinatorKey: string;
	createdAt: number;
	stateBase64: string;
	lastCursor: number;
	fetchCursor: number;
	messages: StoredChatMessage[];
	syncIssues: StoredChatSyncIssue[];
	snapshots: ChatGroupStateSnapshot[];
	status?: 'active' | 'removed' | 'poisoned';
	removedAtCursor?: number;
	poisonedAtCursor?: number;
	metadata?: GroupMetadataInput;
	joinedWithKeyPackageRef?: string;
	joinEpoch: bigint;
}

export interface CoordinatorAvailableKeyPackage {
	stablePubkey: string;
	keyPackageRef: string;
	isLastResort: boolean;
	publishedAt: number;
}

const groupOperationChains = new SvelteMap<string, Promise<unknown>>();
const pendingEpochOperations = createGroupPendingEpochStore();

/** Seal an outbound MLS message under the current epoch's exporter secret
 *  (spec/03 §4-§5). Sealing is always on. Returns the base64 to post, the
 *  `encrypted` flag for PostGroupMessage, and the delivery `gid` the
 *  coordinator needs to route an opaque payload without MLS-decoding it (the
 *  coordinator gates its opaque path on `gid` being present, NOT on the
 *  `encrypted` flag — omitting `gid` forces the legacy decode path and the
 *  sealed blob fails MLS framing). Inbound traffic is still decrypted
 *  transparently when `encrypted` is absent (legacy plaintext from
 *  mixed-version groups). */
async function sealForPosting(params: {
	state: ClientState;
	opaqueMessageBase64: string;
}): Promise<{ msg_64: string; encrypted: true; gid: string }> {
	const { encryptedBase64 } = await encryptGroupPayloadBase64(params);
	return {
		msg_64: encryptedBase64,
		encrypted: true,
		gid: getProtocolGroupId(params.state)
	};
}
let groupsReady: Promise<void> | null = null;
let persistGroupsPromise: Promise<void> = Promise.resolve();
let groupsLoaded = false;

/**
 * Memoizes the decoded MLS ClientState per StoredChatGroup object.
 *
 * `clientStateDecoder` is expensive and was re-run on every read/render that
 * needed members, admin checks, or removed/poisoned status. Group objects in
 * the store are never mutated in place — every state change produces a new
 * object via `replaceGroup`/`fromStoredGroupData`/`buildPersistedChatGroup`,
 * so stale entries are reclaimed automatically when the old object is GC'd.
 * The `stateBase64` guard defends against any future in-place mutation.
 */
const decodedStateCache = new WeakMap<
	StoredChatGroup,
	{ stateBase64: string; state: ClientState }
>();

export const chatGroupsStore = $state<{ groups: StoredChatGroup[] }>({
	groups: []
});

function toStoredGroupData(group: StoredChatGroup): StoredChatGroupData {
	return {
		id: group.id,
		ownerPubkey: group.ownerPubkey,
		coordinatorKey: group.coordinatorKey,
		createdAt: group.createdAt,
		lastCursor: group.lastCursor,
		fetchCursor: group.fetchCursor,
		status: group.status,
		removedAtCursor: group.removedAtCursor,
		poisonedAtCursor: group.poisonedAtCursor,
		joinedWithKeyPackageRef: group.joinedWithKeyPackageRef,
		joinEpoch: group.joinEpoch > 0n ? group.joinEpoch.toString() : undefined,
		stateBytes: base64ToBytes(group.stateBase64),
		// Shallow spread only: both storage backends deep-clone the messages they
		// actually persist, so re-cloning every tag array here was redundant work
		// on every persist (including single-message ingests).
		messages: group.messages.map((message) => ({ ...message })),
		syncIssues: group.syncIssues.map((issue) => ({ ...issue })),
		snapshots: group.snapshots.map((snapshot) => ({
			groupId: snapshot.groupId,
			status: snapshot.status,
			epoch: snapshot.epoch,
			cursor: snapshot.cursor,
			createdAt: snapshot.createdAt,
			stateBytes: base64ToBytes(snapshot.stateBase64),
			triggerCursor: snapshot.triggerCursor,
			triggerMessageId: snapshot.triggerMessageId
		}))
	};
}

function fromStoredGroupData(group: StoredChatGroupData): StoredChatGroup {
	const decoded = clientStateDecoder(group.stateBytes, 0);
	const metadata = decoded
		? toPersistedGroupMetadata(getCordnGroupMetadataExtension(decoded[0]))
		: undefined;
	return {
		id: group.id,
		ownerPubkey: group.ownerPubkey,
		coordinatorKey: group.coordinatorKey,
		createdAt: group.createdAt,
		stateBase64: bytesToBase64(group.stateBytes),
		lastCursor: group.lastCursor ?? 0,
		fetchCursor: group.fetchCursor ?? 0,
		// Shallow spread only: both storage backends return freshly-cloned
		// messages from getGroup(), so the per-tag clone here was redundant.
		messages: group.messages.map((message) => ({ ...message })),
		syncIssues: group.syncIssues.map((issue) => ({ ...issue })),
		snapshots:
			group.snapshots?.map((snapshot) => ({
				...snapshot,
				stateBase64: bytesToBase64(snapshot.stateBytes)
			})) ?? [],
		status: group.status ?? 'active',
		removedAtCursor: group.removedAtCursor,
		poisonedAtCursor: group.poisonedAtCursor,
		metadata,
		joinedWithKeyPackageRef: group.joinedWithKeyPackageRef,
		joinEpoch: group.joinEpoch !== undefined ? BigInt(group.joinEpoch) : 0n
	};
}

async function loadAndNormalizeChatGroup(
	storage: ChatStorage,
	groupId: string
): Promise<{ group: StoredChatGroup; changed: boolean }> {
	const data = await storage.getGroup(groupId);
	if (!data) {
		throw new Error(`Stored group ${groupId} not found`);
	}

	const group = fromStoredGroupData(data);
	let changed = false;

	if (group.snapshots.length === 0 && !isChatGroupPoisoned(group)) {
		try {
			const state = decodeStoredGroupState(group);
			group.snapshots = [
				{
					groupId: group.id,
					status: 'healthy',
					epoch: state.groupContext.epoch.toString(),
					cursor: group.fetchCursor,
					createdAt: Date.now(),
					stateBase64: group.stateBase64
				}
			];
			changed = true;
		} catch {
			// State is undecodable; leave snapshots empty.
		}
	}

	return { group, changed };
}

async function loadGroups(ownerPubkey?: string) {
	await persistGroupsPromise;
	const storage = await getChatStorage();
	const normalizedOwner = ownerPubkey ? normalizePubKey(ownerPubkey) : undefined;

	if (!normalizedOwner) {
		chatGroupsStore.groups = [];
		groupsLoaded = false;
		return;
	}

	const records = await storage.listGroups(normalizedOwner);
	const loaded = await Promise.all(
		records.map((record) => loadAndNormalizeChatGroup(storage, record.id))
	);

	chatGroupsStore.groups = loaded.map((entry) => entry.group);
	if (loaded.some((entry) => entry.changed)) {
		void persistGroups(chatGroupsStore.groups);
	}
	groupsLoaded = true;
}

export async function ensureGroupsLoaded() {
	groupsReady ??= loadGroups(manager.getActive()?.pubkey);
	await groupsReady;
}

function persistGroups(groups: StoredChatGroup[]) {
	persistGroupsPromise = persistGroupsPromise
		.then(async () => {
			const storage = await getChatStorage();
			for (const group of groups) {
				await storage.putGroup(toStoredGroupData(group));
			}
		})
		.catch(() => undefined);
	return persistGroupsPromise;
}

/**
 * Persist a single group on the shared chain. Single-group mutations (a new
 * message ingested, a sent message, a status change) must not re-write every
 * group: each `putGroup` rewrites that group's full message history, so
 * persisting all N groups on every incoming message makes live delivery
 * latency scale with the total group count. The shared `persistGroupsPromise`
 * chain is kept so bulk loads and single-group writes still order safely.
 */
function persistSingleGroup(group: StoredChatGroup) {
	persistGroupsPromise = persistGroupsPromise
		.then(async () => {
			const storage = await getChatStorage();
			await storage.putGroup(toStoredGroupData(group));
		})
		.catch(() => undefined);
	return persistGroupsPromise;
}

export function reloadChatGroupsForOwner(ownerPubkey?: string) {
	groupsLoaded = false;
	groupsReady = loadGroups(ownerPubkey);
	return groupsReady;
}

/**
 * Restore raw group objects to durable storage (backup import). Bypasses the
 * group operation chains: this is a state restore, not a protocol operation.
 * The in-memory store is repopulated by the caller via the active-account
 * reload, or directly via reloadChatGroupsForOwner for the active owner.
 */
export async function importChatGroups(groups: StoredChatGroup[]): Promise<void> {
	const storage = await getChatStorage();
	for (const group of groups) {
		await storage.putGroup(toStoredGroupData(group));
	}
}

function encodeState(state: ClientState): string {
	return bytesToBase64(encode(clientStateEncoder, state));
}

export function decodeStoredGroupState(group: StoredChatGroup): ClientState {
	const cached = decodedStateCache.get(group);
	if (cached && cached.stateBase64 === group.stateBase64) {
		return cached.state;
	}
	const decoded = clientStateDecoder(base64ToBytes(group.stateBase64), 0);
	if (!decoded) {
		throw new Error(`Unable to decode stored group state for ${group.id}`);
	}
	const state = decoded[0];
	decodedStateCache.set(group, { stateBase64: group.stateBase64, state });
	return state;
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

function isPoisoningSyncIssue(issue: StoredChatSyncIssue): boolean {
	return issue.detail.startsWith('Fatal MLS decryption failure');
}

export function isChatGroupPoisoned(group: StoredChatGroup | undefined): boolean {
	if (!group) return false;
	return group.status === 'poisoned' || group.syncIssues.some(isPoisoningSyncIssue);
}

function assertChatGroupIsActive(group: StoredChatGroup): void {
	if (isChatGroupRemoved(group)) {
		throw new RemovedFromGroupError(group.metadata?.name || group.id);
	}
	if (isChatGroupPoisoned(group)) {
		throw new Error('This group is unhealthy and is read-only until recovered.');
	}
}

/**
 * Catch up with coordinator messages before performing an outbound operation.
 * This runs inline (not through runGroupOperation) since it is called from
 * within an already-serialized group operation context.
 * Returns the refreshed group after catch-up.
 */
async function catchUpGroupBeforeOutboundOperation(
	group: StoredChatGroup,
	gid: string
): Promise<StoredChatGroup> {
	assertChatGroupIsActive(group);

	const account = requireActiveAccount('You must be logged in to catch up group messages');
	const hasCursor = group.fetchCursor > 0;
	const sinceEpoch = !hasCursor && group.joinEpoch > 0n ? group.joinEpoch.toString() : undefined;

	let result: {
		messages: Array<{ cursor: number; at: number; msg_64: string; encrypted?: boolean }>;
	};
	try {
		result = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.FetchGroupMessages({
				gid,
				after: hasCursor ? group.fetchCursor : undefined,
				since_epoch: sinceEpoch
			})
		);
	} catch (error) {
		// Network/fetch errors are transient - log and continue with current state
		console.warn('[catch-up] failed to fetch messages before outbound operation', {
			groupId: group.id,
			error: error instanceof Error ? error.message : String(error)
		});
		return requireChatGroup(group.id);
	}

	if (result.messages.length > 0) {
		// Ingestion errors (including poison) must propagate - they indicate real problems
		await applyIncomingChatGroupMessages(
			group,
			result.messages.map((message) => ({
				cursor: message.cursor,
				createdAt: message.at,
				opaqueMessageBase64: message.msg_64,
				encrypted: message.encrypted
			}))
		);
	}

	return requireChatGroup(group.id);
}

/**
 * Assert that a group can perform outbound operations.
 * Performs catch-up with the coordinator and validates the group is healthy.
 * Must be called from within a runGroupOperation context.
 */
export async function assertGroupCanPerformOutboundOperation(
	groupId: string
): Promise<StoredChatGroup> {
	const group = requireChatGroup(groupId);
	assertChatGroupIsActive(group);

	const state = decodeStoredGroupState(group);
	const gid = groupIdDecoder.decode(state.groupContext.groupId);

	const refreshed = await catchUpGroupBeforeOutboundOperation(group, gid);
	assertChatGroupIsActive(refreshed);

	if (isChatGroupPoisoned(refreshed)) {
		throw new Error(
			'This group is unhealthy and is read-only until recovered. Contact an admin for assistance.'
		);
	}

	return refreshed;
}

/**
 * Resolve the group state to use when sending an application message.
 *
 * Application messages (kind 9 / 7 / 1111 / 1010 / 5) never change the MLS
 * epoch, so for a group with an active live subscription the pre-send
 * catch-up fetch is redundant: the subscription keeps local state current up
 * to the last delivered message, and this runs inside the serialized group
 * operation chain so it always sees the post-ingestion state. Only fall back
 * to a full catch-up for groups that are not currently watched.
 */
async function prepareGroupForApplicationMessage(groupId: string): Promise<StoredChatGroup> {
	if (isGroupActivelyWatched(groupId)) {
		const group = requireChatGroup(groupId);
		assertChatGroupIsActive(group);
		return group;
	}
	return assertGroupCanPerformOutboundOperation(groupId);
}

export function listChatGroups(): StoredChatGroup[] {
	return [...chatGroupsStore.groups].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Drop local key package records whose private bytes are spent: consumed to
 * join an existing group and not published anywhere. Safe to call any time —
 * published and still-pending KPs are never touched.
 */
export async function pruneConsumedKeyPackagesForActiveGroups(): Promise<void> {
	const consumedRefs = listChatGroups()
		.map((group) => group.joinedWithKeyPackageRef)
		.filter((ref): ref is string => Boolean(ref));
	await pruneZombieKeyPackages(consumedRefs);
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
	void persistSingleGroup(group);
}

export function replaceGroup(groupId: string, nextGroup: StoredChatGroup) {
	chatGroupsStore.groups = chatGroupsStore.groups.map((group) =>
		group.id === groupId ? nextGroup : group
	);
	void persistSingleGroup(nextGroup);
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
	name?: string;
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
		name: input.name?.trim() ?? '',
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
		ownerPubkey: normalizePubKey(account.pubkey),
		coordinatorKey: normalizedCoordinatorKey,
		stateBase64: encodeState(state),
		metadata,
		joinedWithKeyPackageRef: memberArtifacts.keyPackageRef
	});

	// Create initial healthy snapshot for recovery baseline
	const initialSnapshot: ChatGroupStateSnapshot = {
		groupId: group.id,
		status: 'healthy',
		epoch: state.groupContext.epoch.toString(),
		cursor: 0,
		createdAt: Date.now(),
		stateBase64: group.stateBase64
	};
	group.snapshots = [initialSnapshot];

	persistGroup(group);
	void pruneConsumedKeyPackagesForActiveGroups();
	// spec multi-device §10: a new group must reach siblings so they can seed it.
	// Fire-and-forget; a no-op when multi-device is disabled.
	onLocalStateAdvance();
	return group;
}

export async function acceptChatWelcome(input: { welcomeId: string }): Promise<StoredChatGroup> {
	const account = requireActiveAccount('You must be logged in to accept a welcome');
	const welcome = getWelcomeNotification(input.welcomeId);
	if (!welcome) {
		throw new Error('Stored welcome not found');
	}

	const group = await acceptWelcomeToGroup({
		welcome,
		encodeState
	});
	group.coordinatorKey = normalizePubKey(group.coordinatorKey);
	group.ownerPubkey = normalizePubKey(account.pubkey);
	group.metadata = toPersistedGroupMetadata(group.metadata);

	// Create initial healthy snapshot for recovery baseline
	const state = decodeStoredGroupState(group);
	const initialSnapshot: ChatGroupStateSnapshot = {
		groupId: group.id,
		status: 'healthy',
		epoch: state.groupContext.epoch.toString(),
		cursor: 0,
		createdAt: Date.now(),
		stateBase64: group.stateBase64
	};
	group.snapshots = [initialSnapshot];

	const existingGroup = getChatGroup(group.id);
	if (existingGroup) {
		replaceGroup(existingGroup.id, {
			...group,
			createdAt: existingGroup.createdAt,
			messages: existingGroup.messages,
			syncIssues: existingGroup.syncIssues,
			lastCursor: existingGroup.lastCursor,
			fetchCursor: existingGroup.fetchCursor,
			status: 'active',
			removedAtCursor: undefined
		});
		markWelcomeAccepted(welcome.id, existingGroup.id);
		removeSentJoinRequest(existingGroup.id);
		markCoordinatorUsed(existingGroup.coordinatorKey);
		void pruneConsumedKeyPackagesForActiveGroups();
		return getChatGroup(group.id) ?? group;
	}

	persistGroup(group);
	markCoordinatorUsed(group.coordinatorKey);
	markWelcomeAccepted(welcome.id, group.id);
	removeSentJoinRequest(group.id);
	void pruneConsumedKeyPackagesForActiveGroups();

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

	const result = await queryClient.fetchQuery({
		queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, group.coordinatorKey),
		queryFn: () => fetchCoordinatorAvailableKeyPackages(group.coordinatorKey),
		staleTime: 30 * 1000
	});
	return result
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
		const group = await assertGroupCanPerformOutboundOperation(input.groupId);
		assertCanAdministerGroup({
			groupId: group.id,
			metadata: group.metadata,
			stablePubkey: account.pubkey
		});

		const state = decodeStoredGroupState(group);

		const consumeResult = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.ConsumeKeyPackage({
				id: input.identifier.trim()
			})
		);
		void queryClient.invalidateQueries({
			queryKey: chatQueryKeys.availableKeyPackages(account.pubkey, group.coordinatorKey)
		});

		if (!consumeResult.keyPackage) {
			throw new Error(`No published key package found for ${input.identifier}`);
		}

		const availableKeyPackages = await listCoordinatorAvailableKeyPackages(group.id);
		const normalizedIdentifier = normalizePubKey(input.identifier.trim());
		const matchedAvailableKeyPackage = availableKeyPackages.find(
			(entry) =>
				entry.keyPackageRef === input.identifier.trim() ||
				normalizePubKey(entry.stablePubkey) === normalizedIdentifier
		);
		const targetStablePubkey = normalizePubKey(
			matchedAvailableKeyPackage?.stablePubkey ?? consumeResult.keyPackage.pk
		);
		const existingLeafIndex = findMemberLeafIndexByStablePubkey(state, targetStablePubkey);
		if (existingLeafIndex >= 0) {
			throw new Error('This identity is already a group member. Reinvites are not supported.');
		}

		const memberKeyPackage = await parseConsumedPublishedKeyPackage({
			stablePubkey: normalizePubKey(consumeResult.keyPackage.pk),
			publicationEvent: consumeResult.keyPackage.event
		});

		const commitResult = await addMemberToGroup({
			state,
			memberKeyPackage
		});

		const sealedAddCommit = await sealForPosting({
			state,
			opaqueMessageBase64: commitResult.commitMessageBase64
		});

		// Hoisted to a local so the posted Commit cursor can be stamped on
		// directly. enqueuePendingEpochOperation pushes this same reference
		// (no clone), so mutating it here updates the stored op. Avoids a
		// fragile re-find by commitMessageBase64 (the stored key is the
		// sealed form, not the plaintext commit).
		const addMemberOp: Extract<PendingEpochOperation, { kind: 'add-member' }> = {
			kind: 'add-member',
			groupId: group.id,
			commitMessageBase64: sealedAddCommit.msg_64,
			targetStablePubkey,
			keyPackageReference: consumeResult.keyPackage.kp_ref,
			welcomeBase64: encodeWelcomeBase64(commitResult.welcome)
		};
		enqueuePendingEpochOperation(pendingEpochOperations, addMemberOp);

		const posted = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.PostGroupMessage(sealedAddCommit)
		);

		// Stamp the Commit cursor on the pending op so the Welcome we store
		// carries an `after` hint; the invitee uses it to skip pre-join traffic.
		addMemberOp.postedCursor = posted.cursor;

		const syncBaseGroup: StoredChatGroup = {
			...group,
			stateBase64: encodeState(commitResult.newState),
			metadata:
				toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
				group.metadata
		};
		const hasCursor = group.fetchCursor > 0;
		const sinceEpoch = !hasCursor && group.joinEpoch > 0n ? group.joinEpoch.toString() : undefined;
		const result = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.FetchGroupMessages({
				gid: groupIdDecoder.decode(state.groupContext.groupId),
				after: hasCursor ? group.fetchCursor : undefined,
				since_epoch: sinceEpoch
			})
		);

		const workingGroup = createWorkingChatGroupSession(syncBaseGroup, commitResult.newState);
		const sync = await syncChatGroupMessages({
			group,
			workingGroup,
			messages: result.messages.map((message) => ({
				cursor: message.cursor,
				createdAt: message.at,
				opaqueMessageBase64: message.msg_64,
				encrypted: message.encrypted
			})),
			pendingEpochOperations,
			coordinatorClient: getCoordinatorClient(account, group.coordinatorKey),
			localStablePubkey: normalizePubKey(account.pubkey)
		});

		const inviteSystemMessages = createSystemMessagesFromStateChange({
			cursor: posted.cursor,
			createdAt: posted.at,
			oldState: state,
			newState: commitResult.newState,
			oldMetadata: toPersistedGroupMetadata(getCordnGroupMetadataExtension(state)),
			newMetadata: getCordnGroupMetadataExtension(commitResult.newState),
			committerPubkey: normalizePubKey(account.pubkey)
		});
		for (const systemMessage of inviteSystemMessages) {
			sync.workingGroup.messages.push(systemMessage);
		}

		const nextGroup = buildPersistedChatGroup({
			group: syncBaseGroup,
			workingGroup: sync.workingGroup,
			encodeState,
			metadata: toPersistedGroupMetadata(sync.workingGroup.metadata)
		});

		// Create tentative snapshot for the new epoch
		const tentativeSnapshot = createOutboundTentativeSnapshot({
			groupId: group.id,
			stateBase64: nextGroup.stateBase64,
			fetchCursor: nextGroup.fetchCursor,
			newEpoch: commitResult.newState.groupContext.epoch,
			triggerCursor: posted.cursor
		});
		nextGroup.snapshots = replaceTentativeSnapshot(nextGroup.snapshots, tentativeSnapshot);

		replaceGroup(group.id, nextGroup);
		return nextGroup;
	});
}

export function listChatGroupMembers(
	groupId: string,
	activePubkey?: string
): Array<{
	leafIndex: number;
	stablePubkey: string;
	isAdmin: boolean;
	isSelf: boolean;
}> {
	const group = requireChatGroup(groupId);
	const state = decodeStoredGroupState(group);
	const normalizedActivePubkey = activePubkey ? normalizePubKey(activePubkey) : '';
	const adminPubkeys = group.metadata?.adminPubkeys;
	// No admin list (or empty) means everyone is an admin. Build the normalized
	// set once instead of re-normalizing the whole list per member.
	const adminSet = adminPubkeys?.length ? new SvelteSet(adminPubkeys.map(normalizePubKey)) : null;
	return listGroupMembers(state).map((member) => {
		const normalizedMember = normalizePubKey(member.stablePubkey);
		return {
			...member,
			isAdmin: !adminSet || adminSet.has(normalizedMember),
			isSelf: normalizedActivePubkey ? normalizedMember === normalizedActivePubkey : false
		};
	});
}

export async function removeChatGroupMember(input: {
	groupId: string;
	targetStablePubkey: string;
}): Promise<StoredChatGroup> {
	return runGroupOperation(input.groupId, async () => {
		const account = requireActiveAccount('You must be logged in to remove a member');
		const group = await assertGroupCanPerformOutboundOperation(input.groupId);
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

		const commitResult = await removeMemberFromGroup({ state, removedLeafIndex });

		const sealedRemoveCommit = await sealForPosting({
			state,
			opaqueMessageBase64: commitResult.commitMessageBase64
		});

		enqueuePendingEpochOperation(pendingEpochOperations, {
			kind: 'remove-member',
			groupId: group.id,
			commitMessageBase64: sealedRemoveCommit.msg_64,
			targetStablePubkey: normalizePubKey(input.targetStablePubkey)
		});

		const posted = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.PostGroupMessage(sealedRemoveCommit)
		);

		const removeWorkingGroup = createWorkingChatGroupSession(
			{
				...group,
				metadata:
					toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
					group.metadata
			},
			commitResult.newState
		);

		const removeSystemMessages = createSystemMessagesFromStateChange({
			cursor: posted.cursor,
			createdAt: posted.at,
			oldState: state,
			newState: commitResult.newState,
			oldMetadata: toPersistedGroupMetadata(getCordnGroupMetadataExtension(state)),
			newMetadata: getCordnGroupMetadataExtension(commitResult.newState),
			committerPubkey: normalizePubKey(account.pubkey)
		});
		for (const systemMessage of removeSystemMessages) {
			removeWorkingGroup.messages.push(systemMessage);
		}

		const nextGroup = buildPersistedChatGroup({
			group,
			workingGroup: removeWorkingGroup,
			encodeState,
			metadata:
				toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
				group.metadata
		});

		// Create tentative snapshot for the new epoch
		const tentativeSnapshot = createOutboundTentativeSnapshot({
			groupId: group.id,
			stateBase64: nextGroup.stateBase64,
			fetchCursor: nextGroup.fetchCursor,
			newEpoch: commitResult.newState.groupContext.epoch,
			triggerCursor: posted.cursor
		});
		nextGroup.snapshots = replaceTentativeSnapshot(nextGroup.snapshots, tentativeSnapshot);

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
		const group = await assertGroupCanPerformOutboundOperation(input.groupId);
		assertCanAdministerGroup({
			groupId: group.id,
			metadata: group.metadata,
			stablePubkey: account.pubkey
		});

		const metadata: GroupMetadataInput = {
			name: input.name.trim(),
			description: input.description,
			icon: input.icon,
			imageUrl: input.imageUrl,
			adminPubkeys: input.adminPubkeys
		};
		const state = decodeStoredGroupState(group);
		const commitResult = await updateGroupMetadataExtension({
			state,
			metadata
		});

		const sealedMetadataCommit = await sealForPosting({
			state,
			opaqueMessageBase64: commitResult.commitMessageBase64
		});

		enqueuePendingEpochOperation(pendingEpochOperations, {
			kind: 'update-group-metadata',
			groupId: group.id,
			commitMessageBase64: sealedMetadataCommit.msg_64
		});

		const posted = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.PostGroupMessage(sealedMetadataCommit)
		);

		const metadataWorkingGroup = createWorkingChatGroupSession(
			{
				...group,
				metadata:
					toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ??
					metadata
			},
			commitResult.newState
		);

		const metadataSystemMessages = createSystemMessagesFromStateChange({
			cursor: posted.cursor,
			createdAt: posted.at,
			oldState: state,
			newState: commitResult.newState,
			oldMetadata: toPersistedGroupMetadata(getCordnGroupMetadataExtension(state)),
			newMetadata: getCordnGroupMetadataExtension(commitResult.newState),
			committerPubkey: normalizePubKey(account.pubkey)
		});
		for (const systemMessage of metadataSystemMessages) {
			metadataWorkingGroup.messages.push(systemMessage);
		}

		const nextGroup = buildPersistedChatGroup({
			group,
			workingGroup: metadataWorkingGroup,
			encodeState,
			metadata:
				toPersistedGroupMetadata(getCordnGroupMetadataExtension(commitResult.newState)) ?? metadata
		});

		// Create tentative snapshot for the new epoch
		const tentativeSnapshot = createOutboundTentativeSnapshot({
			groupId: group.id,
			stateBase64: nextGroup.stateBase64,
			fetchCursor: nextGroup.fetchCursor,
			newEpoch: commitResult.newState.groupContext.epoch,
			triggerCursor: posted.cursor
		});
		nextGroup.snapshots = replaceTentativeSnapshot(nextGroup.snapshots, tentativeSnapshot);

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

export function clearChatGroupSyncIssues(groupId: string): void {
	const group = getChatGroup(groupId);
	if (!group || group.syncIssues.length === 0) return;
	replaceGroup(groupId, { ...group, syncIssues: [] });
}

async function applyIncomingChatGroupMessages(
	group: StoredChatGroup,
	messages: Array<{
		cursor: number;
		createdAt: number;
		opaqueMessageBase64: string;
		encrypted?: boolean;
	}>
): Promise<{
	group: StoredChatGroup;
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
	poisoned: boolean;
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

	// Track snapshots for MLS state health
	const oldEpoch = state.groupContext.epoch;
	const newEpoch = workingGroup.state.groupContext.epoch;
	const epochChanged = oldEpoch !== newEpoch;

	let updatedSnapshots = nextGroup.snapshots;

	if (epochChanged) {
		// Epoch changed - create tentative snapshot
		const newSnapshot: ChatGroupStateSnapshot = {
			groupId: group.id,
			status: 'tentative',
			epoch: newEpoch.toString(),
			cursor: workingGroup.fetchCursor,
			createdAt: Date.now(),
			stateBase64: nextGroup.stateBase64,
			triggerCursor: messages[messages.length - 1]?.cursor
		};
		updatedSnapshots = replaceTentativeSnapshot(updatedSnapshots, newSnapshot);
	} else if (sync.received.length > 0) {
		// Successfully decrypted messages in same epoch - promote tentative if present
		const hasTentative = updatedSnapshots.some((s) => s.status === 'tentative');
		if (hasTentative) {
			updatedSnapshots = promoteTentativeSnapshot(updatedSnapshots);
		}
	}

	nextGroup.snapshots = updatedSnapshots;

	replaceGroup(group.id, nextGroup);

	// spec multi-device §10: a locally-authored Commit confirmed via self-echo
	// advanced the epoch — siblings cannot ingest it from the stream (shared-leaf
	// UpdatePath) and need a document fast-forward. `appliedPendingCommitMessages`
	// is exactly the self-echo-confirmed own-Commit set. Fire-and-forget; a no-op
	// when multi-device is disabled.
	if (epochChanged && sync.ingestion.appliedPendingCommitMessages.size > 0) {
		onLocalStateAdvance();
	}

	// If ingestion poisoned the group, throw so the caller aborts
	if (sync.ingestion.poisoned) {
		throw new Error('Group became poisoned during message ingestion');
	}

	return {
		group: nextGroup,
		received: sync.received,
		issues: sync.issues,
		poisoned: sync.ingestion.poisoned
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

		const gid = groupIdDecoder.decode(state.groupContext.groupId);
		const hasCursor = group.fetchCursor > 0;
		const sinceEpoch = !hasCursor && group.joinEpoch > 0n ? group.joinEpoch.toString() : undefined;
		const result = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.FetchGroupMessages({
				gid,
				after: hasCursor ? group.fetchCursor : undefined,
				since_epoch: sinceEpoch
			})
		);

		return applyIncomingChatGroupMessages(
			group,
			result.messages.map((message) => ({
				cursor: message.cursor,
				createdAt: message.at,
				opaqueMessageBase64: message.msg_64,
				encrypted: message.encrypted
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
		encrypted?: boolean;
	}>
): Promise<{
	group: StoredChatGroup;
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
}> {
	if (messages.length === 0) {
		const group = requireChatGroup(groupId);
		return { group, received: [], issues: [] };
	}

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
	reactionTo?: MessageTarget;
	editTo?: MessageTarget;
	deleteTo?: MessageTarget;
	pinTo?: MessageTarget;
	pinOp?: PinOp;
	/** Pre-derived media key (base64) for messages carrying an imeta tag.
	 *  sendChatMediaMessage derives once at the encryption epoch and threads it
	 *  through so the stashed key matches the ciphertext even if the group state
	 *  moved on. Other callers omit it and the key is derived here as before. */
	mediaKeyBase64?: string;
}): Promise<StoredChatMessage> {
	return runGroupOperation(input.groupId, async () => {
		const account = requireActiveAccount('You must be logged in to send a message');
		const group = await prepareGroupForApplicationMessage(input.groupId);

		const outboundShape = resolveOutboundMessage(input);
		// A media attachment (NIP-92 imeta) makes text optional: a media-only
		// message is a valid sealed payload carrying the encrypted-media reference
		// and no body, so don't reject it as "content required".
		const hasMediaAttachment = outboundShape.tags.some((tag) => tag[0] === 'imeta');
		if (!outboundShape.content && !hasMediaAttachment && !input.deleteTo && !input.pinTo) {
			throw new Error('Message content is required');
		}

		const state = decodeStoredGroupState(group);
		const outbound = await createApplicationMessageBase64({
			state,
			event: createUnsignedCordnMessageEvent({
				pubkey: normalizePubKey(account.pubkey),
				content: outboundShape.content,
				kind: outboundShape.kind,
				tags: outboundShape.tags
			}),
			authenticatedData: encodeAuthenticatedSender(normalizePubKey(account.pubkey))
		});

		const sealedOutbound = await sealForPosting({
			state,
			opaqueMessageBase64: outbound.opaqueMessageBase64
		});

		const posted = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.PostGroupMessage(sealedOutbound)
		);

		const stored: StoredChatMessage = {
			cursor: posted.cursor,
			createdAt: posted.at,
			direction: 'outbound',
			sender: normalizePubKey(account.pubkey),
			id: outbound.event.id,
			kind: outbound.event.kind,
			tags: outbound.event.tags,
			content: outbound.event.content,
			encrypted: true,
			// Use the caller-provided key when present (media sends pin it to the
			// encryption epoch); otherwise derive from the current send state.
			mediaKeyBase64: findImetaTag(outbound.event.tags)
				? (input.mediaKeyBase64 ?? bytesToBase64(await deriveMediaKey(state)))
				: undefined
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

/**
 * Attempt to recover a poisoned group by replaying from the newest healthy snapshot.
 *
 * Algorithm:
 * 1. Find newest healthy snapshot
 * 2. Restore state from snapshot
 * 3. Fetch messages using since_epoch from snapshot
 * 4. Replay through ingestion pipeline
 * 5. Clear poisoned status if successful, keep it if failed
 *
 * Returns true if recovery succeeded, false otherwise.
 */
export async function recoverPoisonedChatGroup(groupId: string): Promise<boolean> {
	return runGroupOperation(groupId, async () => {
		const account = requireActiveAccount('You must be logged in to recover a group');
		const group = requireChatGroup(groupId);

		if (!isChatGroupPoisoned(group)) {
			// Group is not poisoned, nothing to recover
			return true;
		}

		const snapshots = group.snapshots;
		const healthySnapshot = getNewestHealthySnapshot(snapshots);

		if (!healthySnapshot) {
			console.warn('[recovery] no healthy snapshot available for group', { groupId });
			return false;
		}

		console.log('[recovery] attempting recovery from healthy snapshot', {
			groupId,
			snapshotEpoch: healthySnapshot.epoch,
			snapshotCursor: healthySnapshot.cursor
		});

		// Restore state from snapshot, clearing poisoned status for replay
		const restoredGroup: StoredChatGroup = {
			...group,
			stateBase64: healthySnapshot.stateBase64,
			fetchCursor: healthySnapshot.cursor,
			status: 'active',
			poisonedAtCursor: undefined,
			syncIssues: []
		};

		// Fetch messages from snapshot epoch
		const state = decodeStoredGroupState(restoredGroup);
		const gid = groupIdDecoder.decode(state.groupContext.groupId);
		const sinceEpoch = healthySnapshot.epoch;

		try {
			const result = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
				client.FetchGroupMessages({
					gid,
					after: healthySnapshot.cursor,
					since_epoch: sinceEpoch
				})
			);

			// Replay through ingestion pipeline
			const sync = await applyIncomingChatGroupMessages(
				restoredGroup,
				result.messages.map((message) => ({
					cursor: message.cursor,
					createdAt: message.at,
					opaqueMessageBase64: message.msg_64,
					encrypted: message.encrypted
				}))
			);

			// If replay poisoned the group again, it is unrecoverable
			if (isChatGroupPoisoned(sync.group)) {
				console.warn('[recovery] replay re-poisoned the group', {
					groupId,
					issueCount: sync.issues.length
				});
				return false;
			}

			console.log('[recovery] successful recovery from snapshot', {
				groupId,
				recoveredEpoch: healthySnapshot.epoch,
				messagesReplayed: result.messages.length
			});

			return true;
		} catch (error) {
			console.warn('[recovery] replay failed with error', {
				groupId,
				error: error instanceof Error ? error.message : String(error)
			});
			// Re-persist poisoned status on failure
			const currentGroup = requireChatGroup(groupId);
			replaceGroup(groupId, {
				...currentGroup,
				status: 'poisoned',
				poisonedAtCursor: group.poisonedAtCursor
			});
			return false;
		}
	});
}

export function deleteChatGroup(groupId: string): void {
	chatGroupsStore.groups = chatGroupsStore.groups.filter((group) => group.id !== groupId);
	removeSentJoinRequest(groupId);
	void getChatStorage().then((storage) => storage.deleteGroup(groupId));
}

export async function deleteChatGroupsForCoordinator(coordinatorKey: string): Promise<void> {
	const normalizedCoordinator = normalizePubKey(coordinatorKey);
	const groupIds = chatGroupsStore.groups
		.filter((group) => group.coordinatorKey === normalizedCoordinator)
		.map((group) => group.id);
	chatGroupsStore.groups = chatGroupsStore.groups.filter(
		(group) => group.coordinatorKey !== normalizedCoordinator
	);
	const storage = await getChatStorage();
	await Promise.all(groupIds.map((id) => storage.deleteGroup(id)));
}

export async function deleteChatGroupsForOwner(ownerPubkey: string): Promise<void> {
	const normalizedOwner = normalizePubKey(ownerPubkey);
	chatGroupsStore.groups = chatGroupsStore.groups.filter(
		(group) => group.ownerPubkey !== normalizedOwner
	);
	const storage = await getChatStorage();
	await storage.deleteGroupsByOwner(normalizedOwner);
}
