import { describe, expect, test } from 'vitest';
import {
	MAX_AUTO_APPROVE_ATTEMPTS,
	MAX_AUTO_APPROVE_COMMITS_PER_HOUR,
	selectAutoApproveTargets,
	type AutoApproveCandidate,
	type AutoApproveGroupContext
} from './chatAutoApprovePolicy';

const alice = 'aa'.repeat(32);
const bob = 'bb'.repeat(32);
const carol = 'cc'.repeat(32);

const enabledAt = 1_000_000;

function candidate(id: string, requester: string, at: number): AutoApproveCandidate {
	return { id, requester, at };
}

function context(overrides: Partial<AutoApproveGroupContext> = {}): AutoApproveGroupContext {
	return {
		isAdmin: true,
		members: [],
		removed: [],
		attempts: {},
		submitting: [],
		recentCommits: 0,
		...overrides
	};
}

describe('selectAutoApproveTargets', () => {
	test('approves eligible requests oldest first', () => {
		const targets = selectAutoApproveTargets(
			[candidate('2', bob, enabledAt + 200), candidate('1', alice, enabledAt + 100)],
			context()
		);
		expect(targets.map((target) => target.id)).toEqual(['1', '2']);
	});

	test('never approves for a non-admin', () => {
		expect(
			selectAutoApproveTargets([candidate('1', alice, enabledAt + 1)], context({ isAdmin: false }))
		).toEqual([]);
	});

	test('skips a requester who is already a member', () => {
		const targets = selectAutoApproveTargets(
			[candidate('1', alice, enabledAt + 1)],
			context({ members: [alice] })
		);
		expect(targets).toEqual([]);
	});

	test('skips a requester this admin removed', () => {
		const targets = selectAutoApproveTargets(
			[candidate('1', alice, enabledAt + 1)],
			context({ removed: [alice] })
		);
		expect(targets).toEqual([]);
	});

	test('approves a backlog that was already waiting when the switch was flipped', () => {
		// No clock comparison: a request older than the switch is still eligible.
		const targets = selectAutoApproveTargets(
			[candidate('1', alice, enabledAt - 60_000), candidate('2', bob, enabledAt - 30_000)],
			context()
		);
		expect(targets.map((target) => target.id)).toEqual(['1', '2']);
	});

	test('skips a request being accepted by hand', () => {
		const targets = selectAutoApproveTargets(
			[candidate('1', alice, enabledAt + 1)],
			context({ submitting: ['1'] })
		);
		expect(targets).toEqual([]);
	});

	test('skips a request out of attempts', () => {
		const targets = selectAutoApproveTargets(
			[candidate('1', alice, enabledAt + 1)],
			context({ attempts: { '1': MAX_AUTO_APPROVE_ATTEMPTS } })
		);
		expect(targets).toEqual([]);
	});

	test('approves a whole backlog in one pass, not a per-person slice', () => {
		// The budget counts Commits, so a batch bigger than the budget still goes in
		// one Commit — a backlog must not trickle in five people at a time.
		const targets = selectAutoApproveTargets(
			[
				candidate('1', alice, enabledAt + 1),
				candidate('2', bob, enabledAt + 2),
				candidate('3', carol, enabledAt + 3)
			],
			context({ recentCommits: MAX_AUTO_APPROVE_COMMITS_PER_HOUR - 1 })
		);
		expect(targets.map((target) => target.id)).toEqual(['1', '2', '3']);
	});

	test('approves nothing once the hourly Commit budget is spent', () => {
		const targets = selectAutoApproveTargets(
			[candidate('1', alice, enabledAt + 1)],
			context({ recentCommits: MAX_AUTO_APPROVE_COMMITS_PER_HOUR })
		);
		expect(targets).toEqual([]);
	});

	test('keeps only the oldest request per requester', () => {
		const targets = selectAutoApproveTargets(
			[candidate('new', alice, enabledAt + 2), candidate('old', alice, enabledAt + 1)],
			context()
		);
		expect(targets.map((target) => target.id)).toEqual(['old']);
	});
});
