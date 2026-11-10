import { describe, expect, test, vi } from 'vitest';

const { listChatGroups } = vi.hoisted(() => ({ listChatGroups: vi.fn(() => []) }));

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$lib/services/accountManager.svelte', () => ({ manager: { getActive: () => undefined } }));
vi.mock('$lib/services/chatGroups.svelte', () => ({ listChatGroups }));
vi.mock('$lib/services/chatAdminPolicy', () => ({ isGroupAdmin: () => false }));
vi.mock('$lib/services/chatRuntime', () => ({
	assertCoordinatorOperationActive: vi.fn(),
	requireActiveAccount: vi.fn(),
	withCoordinatorClientRetry: vi.fn()
}));
vi.mock('$lib/services/coordinatorHealth.svelte', () => ({
	throwIfCoordinatorInReadBackoff: vi.fn()
}));

import {
	listPendingJoinRequests,
	parseSentJoinRequests,
	sentJoinRequestsStore,
	type SentJoinRequestEntry
} from './chatJoinRequests.svelte';

describe('parseSentJoinRequests', () => {
	test('upgrades the old gid array with no coordinator and no time', () => {
		expect(parseSentJoinRequests('["gid-a","gid-b"]')).toEqual([
			{ gid: 'gid-a', coordinatorKey: '', at: 0 },
			{ gid: 'gid-b', coordinatorKey: '', at: 0 }
		]);
	});

	test('reads records and drops the rows it cannot use', () => {
		const raw = JSON.stringify([
			{ gid: 'gid-a', coordinatorKey: 'ab'.repeat(32), name: 'Team', icon: '🚀', at: 20 },
			{ gid: 'gid-b' },
			null,
			'gid-c',
			{ gid: '' },
			{ coordinatorKey: 'ab'.repeat(32) },
			42
		]);

		expect(parseSentJoinRequests(raw)).toEqual([
			{ gid: 'gid-a', coordinatorKey: 'ab'.repeat(32), name: 'Team', icon: '🚀', at: 20 },
			{ gid: 'gid-b', coordinatorKey: '', at: 0 },
			{ gid: 'gid-c', coordinatorKey: '', at: 0 }
		]);
	});

	test('nothing stored, and junk, is an empty list', () => {
		expect(parseSentJoinRequests(null)).toEqual([]);
		expect(parseSentJoinRequests('')).toEqual([]);
		expect(parseSentJoinRequests('not json')).toEqual([]);
		expect(parseSentJoinRequests('{"gid":"a"}')).toEqual([]);
	});
});

describe('listPendingJoinRequests', () => {
	const entry = (gid: string, at: number): SentJoinRequestEntry => ({
		gid,
		coordinatorKey: 'ab'.repeat(32),
		at
	});

	test('newest first, and a request whose group has arrived is done', () => {
		sentJoinRequestsStore.entries = [entry('older', 1), entry('joined', 2), entry('newer', 3)];
		listChatGroups.mockReturnValue([{ id: 'joined' }] as never);

		expect(listPendingJoinRequests().map((pending) => pending.gid)).toEqual(['newer', 'older']);

		sentJoinRequestsStore.entries = [];
	});
});
