import { describe, expect, it, vi } from 'vitest';

import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
import type { StoredChatGroup } from './chatGroups.svelte';

const getGroupMessagesPage = vi.fn();

vi.mock('$app/environment', () => ({ browser: false }));

// Only what these cases touch: the group page read this module performs, plus
// the key-package list the module loads alongside it at startup.
vi.mock('$lib/storage/chatStorage', () => ({
	getChatStorage: async () => ({ getGroupMessagesPage, listKeyPackages: async () => [] })
}));

function rows(cursors: number[]): StoredChatMessage[] {
	return cursors.map((cursor) => ({
		cursor,
		createdAt: cursor,
		direction: 'inbound',
		sender: 'cc'.repeat(32),
		id: `ev-${cursor}`,
		kind: 9,
		tags: [],
		content: `message ${cursor}`
	}));
}

function group(id: string, cursors: number[]): StoredChatGroup {
	return { id, messages: rows(cursors) } as unknown as StoredChatGroup;
}

async function seed(id: string, cursors: number[], pageCursors: number[]) {
	const { chatGroupsStore, ensureChatGroupWindow } = await import('./chatGroups.svelte');
	chatGroupsStore.groups = [group(id, cursors)];
	getGroupMessagesPage.mockResolvedValue(rows(pageCursors));
	return { chatGroupsStore, ensureChatGroupWindow };
}

describe('ensureChatGroupWindow', () => {
	it('leaves the store untouched when the page adds nothing (the render-loop regression)', async () => {
		// The measured bug: each pass rewrote the group object, re-triggering
		// ChatShell's ensure effect → another storage read → another write, at
		// ~18k IndexedDB callbacks/s while a group under the tail size was open.
		const { chatGroupsStore, ensureChatGroupWindow } = await seed('g1', [1, 2, 3], [1, 2, 3]);
		const groups = chatGroupsStore.groups;

		await ensureChatGroupWindow('g1');

		expect(chatGroupsStore.groups).toBe(groups);
		expect(chatGroupsStore.groups[0]).toBe(groups[0]);
	});

	it('extends the window when the page carries a new cursor', async () => {
		const { chatGroupsStore, ensureChatGroupWindow } = await seed('g2', [1, 2], [1, 2, 3]);

		await ensureChatGroupWindow('g2');

		expect(chatGroupsStore.groups[0].messages.map((message) => message.cursor)).toEqual([1, 2, 3]);
	});

	it('skips the read for a window already settled against storage', async () => {
		const { ensureChatGroupWindow } = await seed('g3', [1, 2], [1, 2]);

		await ensureChatGroupWindow('g3');
		const reads = getGroupMessagesPage.mock.calls.length;
		await ensureChatGroupWindow('g3');

		expect(getGroupMessagesPage.mock.calls.length).toBe(reads);
	});

	it('reads again once the window changes', async () => {
		const { chatGroupsStore, ensureChatGroupWindow } = await seed('g4', [1, 2], [1, 2]);
		await ensureChatGroupWindow('g4');
		const reads = getGroupMessagesPage.mock.calls.length;

		chatGroupsStore.groups = [group('g4', [1, 2, 3])];

		await ensureChatGroupWindow('g4');

		expect(getGroupMessagesPage.mock.calls.length).toBe(reads + 1);
	});
});
