import type { cordnClient } from '$lib/services/coordinatorClient';

/** Lifecycle fields shared by every pending own-commit op (staircase
 *  `PendingOp`): the state before the Commit is the rollback target when the
 *  Commit settles as lost or never-landed. `status` is the machine state —
 *  `pending` (absent counts: records written before the field) is awaiting the
 *  echo; `lost` ops stay recognised so their echo can never look like a
 *  sibling Commit, but never send their Welcomes ("no Welcome into a branch
 *  nobody is on"). Every transition goes through this module: the op is the
 *  single source of truth for the fate of an own Commit. */
type PendingEpochOperationBase = {
	/** Machine state: 'pending' (default) | 'lost' (rolled back, echo-skip only). */
	status?: 'pending' | 'lost';
	/** State before the Commit (StoredChatGroup.stateBase64 format). */
	preStateBase64?: string;
	/** Coordinator cursor of the posted Commit, once posted. */
	postedCursor?: number;
};

export type PendingEpochOperation = PendingEpochOperationBase &
	(
		| {
				kind: 'add-member';
				groupId: string;
				commitMessageBase64: string;
				targetStablePubkey: string;
				keyPackageReference: string;
				welcomeBase64: string;
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
		  }
	);

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
	return !!findOperation(store, groupId, opaqueMessageBase64);
}

/** The op staged for this Commit's exact bytes, if any (the echo matcher). */
export function findOperation(
	store: GroupPendingEpochStore,
	groupId: string,
	commitMessageBase64: string
): PendingEpochOperation | undefined {
	return (store.get(groupId) ?? []).find(
		(operation) => operation.commitMessageBase64 === commitMessageBase64
	);
}

/** Ops still awaiting their echo (`pending`; `lost` ops are done, kept only
 *  for echo recognition). */
export function outstandingOperations(
	store: GroupPendingEpochStore,
	groupId: string
): PendingEpochOperation[] {
	return (store.get(groupId) ?? []).filter((operation) => operation.status !== 'lost');
}

/** Stamp the post's coordinator cursor on its op: settlement and rollback
 *  need to know where the change landed. Idempotent (add-member already
 *  stamps its Welcome `after` hint — same value). */
export function stampOperationPosted(
	store: GroupPendingEpochStore,
	groupId: string,
	commitMessageBase64: string,
	postedCursor: number
): void {
	const pending = store.get(groupId);
	if (!pending) return;
	store.set(
		groupId,
		pending.map((operation) =>
			operation.commitMessageBase64 === commitMessageBase64
				? { ...operation, postedCursor }
				: operation
		)
	);
}

/** Terminal transition to `lost`: rolled back, echo-recognition only. */
export function markOperationLost(
	store: GroupPendingEpochStore,
	groupId: string,
	commitMessageBase64: string
): void {
	const pending = store.get(groupId);
	if (!pending) return;
	store.set(
		groupId,
		pending.map((operation) =>
			operation.commitMessageBase64 === commitMessageBase64
				? { ...operation, status: 'lost' as const }
				: operation
		)
	);
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
	const welcomeStores: Promise<unknown>[] = [];

	for (const operation of pending) {
		if (!matched.has(operation.commitMessageBase64) || operation.status === 'lost') {
			// Lost ops stay recognised (their echo must never look like a sibling
			// Commit) but send no Welcomes into a branch nobody is on.
			remaining.push(operation);
			continue;
		}

		if (operation.kind === 'add-member') {
			// StoreWelcome calls are independent per target, so fan them out: a
			// batch add otherwise pays a sequential round-trip per new member,
			// each posting the full Welcome. The store is only updated after all
			// resolve, so a failure leaves the ops pending for retry (unchanged).
			welcomeStores.push(
				client.StoreWelcome({
					target_pk: operation.targetStablePubkey,
					kp_ref: operation.keyPackageReference,
					welcome_64: operation.welcomeBase64,
					after: operation.postedCursor
				})
			);
		}
	}

	await Promise.all(welcomeStores);

	if (remaining.length === 0) {
		store.delete(groupId);
		return;
	}

	store.set(groupId, remaining);
}

export function rejectPendingEpochOperations(
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
