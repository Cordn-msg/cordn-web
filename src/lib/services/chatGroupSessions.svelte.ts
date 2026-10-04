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
	/** Last skipped sibling Commit (spec §10 step 1 fork evidence). */
	skippedSiblingCommit?: { epoch: string; cursor: number };
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
	/** Written by ingestion's sibling-skip hook (spec §10 step 1). */
	skippedSiblingCommit?: { epoch: string; cursor: number };
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
	}>;
	pendingEpochOperations: GroupPendingEpochStore;
	coordinatorClient: Pick<cordnClient, 'StoreWelcome'>;
	localStablePubkey?: string;
	mdActive?: boolean;
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
		localStablePubkey: params.localStablePubkey,
		mdActive: params.mdActive
	});

	try {
		await reconcilePendingEpochOperations({
			store: params.pendingEpochOperations,
			groupId: params.group.id,
			client: params.coordinatorClient,
			ingestion: sync
		});
	} catch (error) {
		// Finalization is retry-on-next-sync: a failing StoreWelcome (stale key
		// package, rate limit) must NOT abort the sync — the batch would never
		// persist, fetchCursor would never advance, and one permanently-rejected
		// welcome would wedge the group's entire ingestion. Ops stay pending by
		// design (finalize drops them only on success).
		console.error('[chat-groups] pending epoch op reconcile failed', {
			groupId: params.group.id,
			error
		});
	}

	// Multi-device re-publish on an own-Commit is NOT fired here. It is fired
	// unconditionally at the end of `runOutboundGroupOperation` (the chokepoint
	// invite/remove/metadata route through) — see chatGroups.svelte.ts. Firing it
	// here was contingent on detecting the self-echo
	// (`appliedPendingCommitMessages.size > 0`), which is fragile: the pending-op
	// marker is an in-memory Map lost on reload, and the self-echo needs the watch
	// to be running. The read-path divergence diff (§10.5) is the backstop.

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
		poisonedAtCursor: params.workingGroup.poisonedAtCursor,
		// Fork evidence written by ingestion's sibling-skip hook (spec §10 step
		// 1) — a fresh skip replaces, no skip keeps the previous one (cleared on
		// document adoption).
		skippedSiblingCommit:
			params.workingGroup.skippedSiblingCommit ?? params.group.skippedSiblingCommit
	};
}
