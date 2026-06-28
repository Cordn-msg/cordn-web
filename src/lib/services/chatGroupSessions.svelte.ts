import type { ClientState } from 'ts-mls';

import {
	ingestChatGroupMessages,
	type StoredChatMessage,
	type StoredChatSyncIssue
} from '$lib/services/chatGroupMessages.svelte';
import {
	type GroupIngestionOutcome,
	type GroupPendingEpochStore,
	hasPendingEpochOperation,
	reconcilePendingEpochOperations
} from '$lib/services/chatGroupProtocol';
import type { cordnClient } from '$lib/services/coordinatorClient';
import type { CordnGroupMetadata } from '$lib/services/chatMlsUtils';

export interface PersistedChatGroupLike {
	id: string;
	stateBase64: string;
	metadata?: CordnGroupMetadata;
	lastCursor: number;
	fetchCursor: number;
	messages: StoredChatMessage[];
	syncIssues: StoredChatSyncIssue[];
	status?: 'active' | 'removed' | 'poisoned';
	removedAtCursor?: number;
	poisonedAtCursor?: number;
}

export interface WorkingChatGroupSession {
	state: ClientState;
	metadata?: CordnGroupMetadata;
	lastCursor: number;
	fetchCursor: number;
	messages: StoredChatMessage[];
	syncIssues: StoredChatSyncIssue[];
	status?: 'active' | 'removed' | 'poisoned';
	removedAtCursor?: number;
	poisonedAtCursor?: number;
}

export function createWorkingChatGroupSession(
	group: PersistedChatGroupLike,
	state: ClientState
): WorkingChatGroupSession {
	return {
		state,
		metadata: group.metadata,
		lastCursor: group.lastCursor,
		fetchCursor: group.fetchCursor,
		messages: [...group.messages],
		syncIssues: [...group.syncIssues],
		status: group.status,
		removedAtCursor: group.removedAtCursor,
		poisonedAtCursor: group.poisonedAtCursor
	};
}

export async function syncChatGroupMessages(params: {
	group: PersistedChatGroupLike;
	workingGroup: WorkingChatGroupSession;
	messages: Array<{
		cursor: number;
		createdAt: number;
		opaqueMessageBase64: string;
		encrypted?: boolean;
	}>;
	pendingEpochOperations: GroupPendingEpochStore;
	coordinatorClient: Pick<cordnClient, 'StoreWelcome'>;
	localStablePubkey?: string;
}): Promise<{
	workingGroup: WorkingChatGroupSession;
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
	ingestion: GroupIngestionOutcome;
}> {
	const sync = await ingestChatGroupMessages({
		group: params.workingGroup,
		messages: params.messages,
		hasPendingEpochOperation: (opaqueMessageBase64) =>
			hasPendingEpochOperation(params.pendingEpochOperations, params.group.id, opaqueMessageBase64),
		localStablePubkey: params.localStablePubkey
	});

	await reconcilePendingEpochOperations({
		store: params.pendingEpochOperations,
		groupId: params.group.id,
		client: params.coordinatorClient,
		ingestion: sync
	});

	return {
		workingGroup: params.workingGroup,
		received: sync.received,
		issues: sync.issues,
		ingestion: sync
	};
}

export function buildPersistedChatGroup<TGroup extends PersistedChatGroupLike>(params: {
	group: TGroup;
	workingGroup: WorkingChatGroupSession;
	encodeState: (state: ClientState) => string;
	metadata?: CordnGroupMetadata;
}): TGroup {
	return {
		...params.group,
		stateBase64: params.encodeState(params.workingGroup.state),
		metadata: params.metadata ?? params.workingGroup.metadata ?? params.group.metadata,
		lastCursor: params.workingGroup.lastCursor,
		fetchCursor: params.workingGroup.fetchCursor,
		messages: params.workingGroup.messages,
		syncIssues: params.workingGroup.syncIssues.slice(-50),
		status: params.workingGroup.status,
		removedAtCursor: params.workingGroup.removedAtCursor,
		poisonedAtCursor: params.workingGroup.poisonedAtCursor
	};
}
