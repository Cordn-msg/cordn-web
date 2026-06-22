import type { ChatGroupStateSnapshotStatus } from '$lib/storage/chatStorage';

/**
 * Service-layer snapshot type using base64-encoded state.
 * Mirrors StoredChatGroupStateSnapshot but uses stateBase64 instead of stateBytes.
 */
export interface ChatGroupStateSnapshot {
	groupId: string;
	status: ChatGroupStateSnapshotStatus;
	epoch: string;
	cursor: number;
	createdAt: number;
	stateBase64: string;
	triggerCursor?: number;
	triggerMessageId?: string;
}

/**
 * Snapshot registry helpers for MLS state health tracking.
 *
 * Rules:
 * - Keep at most 3 snapshots per group
 * - Keep at most 1 tentative snapshot
 * - Tentative snapshot (if present) is always newest
 * - New tentative replaces old tentative
 * - Promotion flips tentative to healthy without evicting previous healthy snapshots
 */

export function appendHealthySnapshot(
	snapshots: ChatGroupStateSnapshot[],
	next: ChatGroupStateSnapshot
): ChatGroupStateSnapshot[] {
	const withoutTentative = snapshots.filter((snapshot) => snapshot.status === 'healthy');
	const healthySnapshot: ChatGroupStateSnapshot = { ...next, status: 'healthy' };
	return [...withoutTentative, healthySnapshot].slice(-3);
}

export function replaceTentativeSnapshot(
	snapshots: ChatGroupStateSnapshot[],
	next: ChatGroupStateSnapshot
): ChatGroupStateSnapshot[] {
	const healthy = snapshots.filter((snapshot) => snapshot.status === 'healthy').slice(-2);
	const tentativeSnapshot: ChatGroupStateSnapshot = { ...next, status: 'tentative' };
	return [...healthy, tentativeSnapshot];
}

export function promoteTentativeSnapshot(
	snapshots: ChatGroupStateSnapshot[]
): ChatGroupStateSnapshot[] {
	return snapshots.map((snapshot) =>
		snapshot.status === 'tentative'
			? { ...snapshot, status: 'healthy' as ChatGroupStateSnapshotStatus }
			: snapshot
	);
}

export function getNewestHealthySnapshot(
	snapshots: ChatGroupStateSnapshot[]
): ChatGroupStateSnapshot | undefined {
	return [...snapshots]
		.filter((snapshot) => snapshot.status === 'healthy')
		.sort((a, b) => b.createdAt - a.createdAt)[0];
}

/**
 * Create a tentative snapshot for an outbound epoch-changing operation.
 * This is called after a successful commit is posted and synced.
 */
export function createOutboundTentativeSnapshot(params: {
	groupId: string;
	stateBase64: string;
	fetchCursor: number;
	newEpoch: bigint;
	triggerCursor: number;
}): ChatGroupStateSnapshot {
	return {
		groupId: params.groupId,
		status: 'tentative',
		epoch: params.newEpoch.toString(),
		cursor: params.fetchCursor,
		createdAt: Date.now(),
		stateBase64: params.stateBase64,
		triggerCursor: params.triggerCursor
	};
}
