import { describe, expect, test } from 'vitest';
import { selectNotificationPreview } from './chatNotificationPreviewText';
import type { StoredChatMessage } from './chatGroupMessages.svelte';

const owner = 'aa'.repeat(32);

function message(overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
	return {
		cursor: 1,
		createdAt: 100,
		direction: 'inbound',
		sender: 'bb'.repeat(32),
		id: 'id',
		kind: 9,
		tags: [],
		content: 'hello',
		...overrides
	};
}

describe('notification preview selection', () => {
	test('picks the newest unread message and counts the rest', () => {
		const selected = selectNotificationPreview(
			[
				message({ cursor: 4, content: 'old but unread' }),
				message({ cursor: 5, content: 'middle' }),
				message({ cursor: 6, content: 'newest' })
			],
			owner,
			3
		);
		expect(selected?.last.content).toBe('newest');
		expect(selected?.count).toBe(3);
	});

	test('drops messages at or below the read cursor', () => {
		const selected = selectNotificationPreview(
			[message({ cursor: 4, content: 'read' }), message({ cursor: 5, content: 'unread' })],
			owner,
			4
		);
		expect(selected?.last.content).toBe('unread');
		expect(selected?.count).toBe(1);
	});

	test('ignores own messages, system rows, and everything at or below the read cursor', () => {
		const selected = selectNotificationPreview(
			[
				message({ cursor: 1 }),
				message({ cursor: 2, sender: owner }),
				message({ cursor: 3, kind: -1, content: 'system' }),
				message({ cursor: 4, content: 'visible' })
			],
			owner,
			1
		);
		expect(selected?.last.content).toBe('visible');
		expect(selected?.count).toBe(1);
	});

	test('returns nothing when no message qualifies', () => {
		expect(
			selectNotificationPreview([message({ cursor: 1, sender: owner })], owner, 0)
		).toBeUndefined();
	});
});
