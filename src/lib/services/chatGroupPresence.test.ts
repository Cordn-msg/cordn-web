import { describe, expect, test, vi } from 'vitest';
import type { StoredChatGroup } from './chatGroups.svelte';

const groups = vi.hoisted(() => new Map<string, StoredChatGroup>());

vi.mock('$app/environment', () => ({ browser: false }));

vi.mock('$lib/services/chatGroups.svelte', () => ({
	getChatGroup: (id: string) => groups.get(id),
	listChatGroups: () => [...groups.values()],
	areChatGroupsLoaded: () => true,
	listChatGroupMessages: (id: string) => {
		const group = groups.get(id);
		return group ? [...group.messages].sort((a, b) => a.cursor - b.cursor) : [];
	}
}));

import {
	getUnreadChatGroupMessageCount,
	listUnreadChatGroupReferenceTargets,
	markChatGroupMentionsRead,
	markChatGroupRead
} from './chatGroupPresence.svelte';

const MEMBER = 'cc'.repeat(32);
const MENTIONED = 'dd'.repeat(32);

function seedGroup(id: string, cursors: number[]): void {
	const lastCursor = Math.max(...cursors);
	groups.set(id, {
		id,
		coordinatorKey: 'aa'.repeat(32),
		createdAt: 1,
		stateBase64: '',
		lastCursor,
		fetchCursor: lastCursor,
		messages: cursors.map((cursor, index) => ({
			cursor,
			createdAt: cursor,
			direction: 'inbound' as const,
			sender: MEMBER,
			id: `${id}-${index}`,
			kind: 9,
			tags: index === 0 ? [['p', MENTIONED]] : [],
			content: `message ${index}`
		})),
		syncIssues: [],
		snapshots: [],
		joinEpoch: 0n,
		status: 'active'
	});
}

describe('chat group presence unread scans', () => {
	test('counts unread messages until the read cursor catches up', () => {
		seedGroup('presence-g1', [10, 20, 30]);
		expect(getUnreadChatGroupMessageCount('presence-g1')).toBe(3);

		markChatGroupRead('presence-g1', 30);
		// Exercises the lastCursor O(1) guard: no full-history rescan needed.
		expect(getUnreadChatGroupMessageCount('presence-g1')).toBe(0);
	});

	test('lists unread mention references and stops once the mention cursor catches up', () => {
		seedGroup('presence-g2', [10, 20]);
		const targets = listUnreadChatGroupReferenceTargets('presence-g2', MENTIONED);
		expect(targets).toHaveLength(1); // only the first message carries the p tag
		expect(targets[0]?.reference.id).toBe('presence-g2-0');

		markChatGroupMentionsRead('presence-g2', 20);
		// Exercises the lastCursor O(1) guard on the mention path.
		expect(listUnreadChatGroupReferenceTargets('presence-g2', MENTIONED)).toEqual([]);
	});

	test('mention scan ignores messages from the referenced account itself', () => {
		seedGroup('presence-g3', [10]);
		expect(listUnreadChatGroupReferenceTargets('presence-g3', MEMBER)).toEqual([]);
	});
});
