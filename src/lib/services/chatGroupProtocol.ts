import type { cordnClient } from '$lib/services/coordinatorClient';

export type PendingEpochOperation =
	| {
			kind: 'add-member';
			groupId: string;
			commitMessageBase64: string;
			targetStablePubkey: string;
			keyPackageReference: string;
			welcomeBase64: string;
			/** Coordinator cursor of the posted Commit, passed to the invitee as
			 *  the Welcome `after` hint so they can skip pre-join traffic. */
			postedCursor?: number;
	  }
	| {
			kind: 'remove-member';
			groupId: string;
			commitMessageBase64: string;
			targetStablePubkey: string;
	  }
	| {
			kind: 'update-group-metadata';
			groupId: string;
			commitMessageBase64: string;
	  }
	| {
			kind: 'self-update';
			groupId: string;
			commitMessageBase64: string;
	  };

export type GroupPendingEpochStore = Map<string, PendingEpochOperation[]>;

export type GroupIngestionOutcome = {
	appliedPendingCommitMessages: Set<string>;
	rejectedPendingCommitMessages: Set<string>;
	poisoned: boolean;
};

export function createGroupPendingEpochStore(): GroupPendingEpochStore {
	return new Map<string, PendingEpochOperation[]>();
}

export function enqueuePendingEpochOperation(
	store: GroupPendingEpochStore,
	operation: PendingEpochOperation
) {
	const existing = store.get(operation.groupId) ?? [];
	existing.push(operation);
	store.set(operation.groupId, existing);
}

export function hasPendingEpochOperation(
	store: GroupPendingEpochStore,
	groupId: string,
	opaqueMessageBase64: string
): boolean {
	const pending = store.get(groupId) ?? [];
	return pending.some((operation) => operation.commitMessageBase64 === opaqueMessageBase64);
}

async function finalizePendingEpochOperations(
	store: GroupPendingEpochStore,
	groupId: string,
	client: Pick<cordnClient, 'StoreWelcome'>,
	opaqueMessageBase64s: Iterable<string>
) {
	const pending = store.get(groupId);
	if (!pending?.length) return;

	const matched = new Set(opaqueMessageBase64s);
	const remaining: PendingEpochOperation[] = [];

	for (const operation of pending) {
		if (!matched.has(operation.commitMessageBase64)) {
			remaining.push(operation);
			continue;
		}

		if (operation.kind === 'add-member') {
			await client.StoreWelcome({
				target_pk: operation.targetStablePubkey,
				kp_ref: operation.keyPackageReference,
				welcome_64: operation.welcomeBase64,
				after: operation.postedCursor
			});
		}
	}

	if (remaining.length === 0) {
		store.delete(groupId);
		return;
	}

	store.set(groupId, remaining);
}

function rejectPendingEpochOperations(
	store: GroupPendingEpochStore,
	groupId: string,
	opaqueMessageBase64s: Iterable<string>
) {
	const pending = store.get(groupId);
	if (!pending?.length) return;

	const rejected = new Set(opaqueMessageBase64s);
	const remaining = pending.filter((operation) => !rejected.has(operation.commitMessageBase64));

	if (remaining.length === 0) {
		store.delete(groupId);
		return;
	}

	store.set(groupId, remaining);
}

/**
 * Drop any pending `add-member` op for a target. Used when the target is removed
 * before their Welcome was finalized: without this, a Welcome persisted before
 * a reload could be delivered (StoreWelcome) by a post-reload sync AFTER the
 * member was removed, handing them a Welcome to a group they just left. Both
 * the stored op and the passed target are normalized pubkeys, so a raw compare
 * is safe. remove-member / metadata ops are left intact.
 */
export function dropPendingAddMemberForTarget(
	store: GroupPendingEpochStore,
	groupId: string,
	targetStablePubkey: string
) {
	const pending = store.get(groupId);
	if (!pending?.length) return;
	const remaining = pending.filter(
		(operation) =>
			operation.kind !== 'add-member' || operation.targetStablePubkey !== targetStablePubkey
	);
	if (remaining.length === 0) {
		store.delete(groupId);
		return;
	}
	store.set(groupId, remaining);
}

export async function reconcilePendingEpochOperations(params: {
	store: GroupPendingEpochStore;
	groupId: string;
	client: Pick<cordnClient, 'StoreWelcome'>;
	ingestion: GroupIngestionOutcome;
}) {
	if (params.ingestion.appliedPendingCommitMessages.size > 0) {
		await finalizePendingEpochOperations(
			params.store,
			params.groupId,
			params.client,
			params.ingestion.appliedPendingCommitMessages
		);
	}

	if (params.ingestion.rejectedPendingCommitMessages.size > 0) {
		rejectPendingEpochOperations(
			params.store,
			params.groupId,
			params.ingestion.rejectedPendingCommitMessages
		);
	}
}
