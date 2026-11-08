import { describe, expect, it, vi } from 'vitest';

import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
import type { StoredChatGroup } from './chatGroups.svelte';

const getGroupMessagesPage = vi.fn();

vi.mock('$app/environment', () => ({ browser: false }));

// Only the read this module performs is needed; the rest of the surface stays
// absent so an accidental new dependency fails loudly in the tests that care.
vi.mock('$lib/storage/chatStorage', () => ({
	getChatStorage: async () => ({ getGroupMessagesPage, listKeyPackages: async () => [] })
}));

function rows(cursors: number[]): StoredChatMessage[] {
	return cursors.map((cursor) => ({
		cursor,
		downloadedAt: 0,
		direction: 'incoming',
		sender: 'aa'.repeat(32),
		content: `message ${cursor}`,
		kind: 9,
		origin: 'live',
		receivedAt: 0,
		tags: []
	})) as unknown as StoredChatMessage[];
}

function group(id: string, cursorList: number[]) {
	return { id, messages: rows(cursorList) } as unknown as StoredChatMessage extends never
		? never
		: StoredChatGroup;
}

describe('ensureChatGroupWindow', () => {
	it('does not rewrite the group when the page adds nothing (render-loop regression)', async () => {
		// The measured bug: each pass rewrote the group object, re-triggering
		// ChatShell's ensure effect → another storage read → another write, at
		// ~18k IndexedDB callbacks/s while a group under the tail size was open.
		const { chatGroupsStore, ensureChatGroupWindow } = await import('./chatGroups.svelte');
		chatGroupsStore.groups = [group('g1', [1, 2, 3])];
		const groups = chatGroupsStore.groups;
		const first = groups[0];
		getGroupMessagesPage.mockResolvedValue(rows([1, 2, 3]));

		await ensureChatGroupWindow('g1');

		expect(chatGroupsStore.groups).toBe(groups);
		expect(chatGroupsStore.groups[0]).toBe(first);
	});

	it('extends the window when the page carries a new cursor', async () => {
		const { chatGroupsStore, ensureChatGroupWindow } = await import('./chatGroups.svelte');
		chatGroupsStore.groups = [group('g2', [1, 2])];
		getGroupMessagesPage.mockResolvedValue(rows([1, 2, 3]));

		await ensureChatGroupWindow('g2');

		expect(chatGroupsStore.groups[0].messages.map((message) => message.cursor)).toEqual([1, 2, 3]);
	});

	it('skips the read for a window already settled against storage', async () => {
		const { chatGroupsStore, ensureChatGroupWindow } = await import('./chatGroups.svelte');
		chatGroupsStore.groups = [group('g3', [1, 2])];
		getGroupMessagesPage.mockResolvedValue(rows([1, 2]));

		await ensureChatGroupWindow('g3');
		const reads = getGroupMessagesPage.mock.calls.length;
		await ensureChatGroupWindow('g3');

		expect(getGroupMessagesPage.mock.calls.length).toBe(reads);
	});
});
