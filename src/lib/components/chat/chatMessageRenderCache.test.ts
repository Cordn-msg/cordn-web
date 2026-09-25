import { describe, it, expect } from 'vitest';
import { estimateChatMessageHeight } from '$lib/components/chat/chatMessageRenderCache';
import type { ChatMessage } from '$lib/components/chat/chat.types';

function msg(partial: Partial<ChatMessage>): ChatMessage {
	return {
		id: 'm',
		eventId: 'e',
		author: 'aa',
		text: '',
		kind: 1,
		createdAt: 0,
		timeLabel: '',
		dayLabel: '',
		...partial
	};
}

describe('estimateChatMessageHeight', () => {
	it('buckets system rows, media rows and short text rows', () => {
		expect(estimateChatMessageHeight(msg({ systemKind: 'member-added' }))).toBe(48);
		expect(
			estimateChatMessageHeight(msg({ media: { mime: 'image/png', filename: 'a.png' } }))
		).toBe(264);
		expect(estimateChatMessageHeight(msg({ tags: [['imeta', 'url x']] }))).toBe(264);
		expect(estimateChatMessageHeight(msg({ text: 'hi' }))).toBe(84);
	});

	it('grows text estimates with length and caps at five lines', () => {
		expect(estimateChatMessageHeight(msg({ text: 'x'.repeat(240) }))).toBe(124);
		expect(estimateChatMessageHeight(msg({ text: 'x'.repeat(2000) }))).toBe(164);
	});
});
