import { normalizePubKey } from '$lib/utils';

/**
 * Pure guard rules for auto-approving join requests. Kept out of the runner so
 * every rule is unit-testable without MLS state or a coordinator.
 *
 * The feature exists to save admins a tap, not to make membership decisions for
 * them: anything that could undo a deliberate act (a removal) or duplicate an
 * existing member stays manual.
 */

/** Keep each MLS Commit bounded; the runner drains larger backlogs in serial batches. */
export const MAX_AUTO_APPROVE_BATCH_SIZE = 15;

/** Session attempts per request before it is left for a human. */
export const MAX_AUTO_APPROVE_ATTEMPTS = 3;

export interface AutoApproveCandidate {
	/** Stable id of the join request row. */
	id: string;
	/** Requester's stable pubkey (normalized here). */
	requester: string;
	/** Request timestamp in ms. */
	at: number;
}

export interface AutoApproveGroupContext {
	/** The active account is an admin of this group. */
	isAdmin: boolean;
	/** Current member pubkeys. */
	members: string[];
	/** Pubkeys with a member-removed system message in the durable history. */
	removed: string[];
	/** Session attempt counts by request id. */
	attempts: Record<string, number>;
	/** Requests already being accepted by hand. */
	submitting: string[];
}

/**
 * Up to one batch of requests this group may auto-approve now, oldest first.
 * Every skip is a guard: not an admin, already a member, previously removed,
 * already being handled by hand, or out of attempts. There is no timestamp or
 * hourly-budget rule: the runner keeps taking batches until the backlog drains.
 */
export function selectAutoApproveTargets(
	candidates: AutoApproveCandidate[],
	context: AutoApproveGroupContext
): AutoApproveCandidate[] {
	if (!context.isAdmin) return [];

	const members = new Set(context.members.map(normalizePubKey));
	const removed = new Set(context.removed.map(normalizePubKey));
	const submitting = new Set(context.submitting);

	const seen = new Set<string>();
	const targets: AutoApproveCandidate[] = [];
	for (const candidate of [...candidates].sort((a, b) => a.at - b.at)) {
		const requester = normalizePubKey(candidate.requester);
		if (!requester) continue;
		if (seen.has(requester)) continue;
		if (members.has(requester)) continue;
		if (removed.has(requester)) continue;
		if (submitting.has(candidate.id)) continue;
		if ((context.attempts[candidate.id] ?? 0) >= MAX_AUTO_APPROVE_ATTEMPTS) continue;
		seen.add(requester);
		targets.push(candidate);
		if (targets.length >= MAX_AUTO_APPROVE_BATCH_SIZE) break;
	}
	return targets;
}
