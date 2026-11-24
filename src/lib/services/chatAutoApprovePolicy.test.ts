import { describe, expect, test } from 'vitest';
import {
	MAX_AUTO_APPROVE_ATTEMPTS,
	MAX_AUTO_APPROVE_BATCH_SIZE,
	selectAutoApproveTargets,
	type AutoApproveCandidate,
	type AutoApproveGroupContext
} from './chatAutoApprovePolicy';

const alice = 'aa'.repeat(32);
const bob = 'bb'.repeat(32);

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

	test('caps one batch at 15 oldest eligible requests', () => {
		const candidates = Array.from({ length: MAX_AUTO_APPROVE_BATCH_SIZE + 2 }, (_, index) =>
			candidate(
				String(index + 1),
				String(index + 1)
					.padStart(2, '0')
					.repeat(32),
				enabledAt + index
			)
		);

		const targets = selectAutoApproveTargets(candidates.reverse(), context());

		expect(targets.map((target) => target.id)).toEqual(
			Array.from({ length: MAX_AUTO_APPROVE_BATCH_SIZE }, (_, index) => String(index + 1))
		);
	});

	test('keeps only the oldest request per requester', () => {
		const targets = selectAutoApproveTargets(
			[candidate('new', alice, enabledAt + 2), candidate('old', alice, enabledAt + 1)],
			context()
		);
		expect(targets.map((target) => target.id)).toEqual(['old']);
	});
});
