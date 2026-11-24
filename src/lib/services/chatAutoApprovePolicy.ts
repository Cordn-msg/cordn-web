import { normalizePubKey } from '$lib/utils';

/**
 * Pure guard rules for auto-approving join requests. Kept out of the runner so
 * every rule is unit-testable without MLS state or a coordinator.
 *
 * The feature exists to save admins a tap, not to make membership decisions for
 * them: anything that could undo a deliberate act (a removal) or duplicate an
 * existing member stays manual.
 */

/**
 * Per group, rolling hour, counted in Commits — not people. A pass approves every
 * eligible request in ONE Commit, so a backlog costs the same as a single request;
 * the budget exists to stop a flood of requests turning into a flood of Commits.
 */
export const MAX_AUTO_APPROVE_COMMITS_PER_HOUR = 5;

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
	/** Commits already made in this group's rolling hour. */
	recentCommits: number;
}

/**
 * The requests this group may auto-approve right now, oldest first.
 * Every skip is a guard: not an admin, already a member, previously removed,
 * already being handled by hand, or out of attempts / hourly Commit budget.
 * There is no "waiting when the switch was flipped" rule: enabling applies to
 * whatever is already waiting, and one pass still costs a single Commit.
 */
export function selectAutoApproveTargets(
	candidates: AutoApproveCandidate[],
	context: AutoApproveGroupContext
): AutoApproveCandidate[] {
	if (!context.isAdmin) return [];

	const members = new Set(context.members.map(normalizePubKey));
	const removed = new Set(context.removed.map(normalizePubKey));
	const submitting = new Set(context.submitting);
	if (context.recentCommits >= MAX_AUTO_APPROVE_COMMITS_PER_HOUR) return [];

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
	}
	return targets;
}
