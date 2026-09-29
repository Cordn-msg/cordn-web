import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
	formatChatMessagePreviewText,
	getChatMessagePreviewText
} from '$lib/components/chat/chatGroupDisplay';
import { SYSTEM_MESSAGE_KIND } from '$lib/chat/kinds';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

const ALICE = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);

function message(overrides: Partial<StoredChatMessage>): StoredChatMessage {
	return {
		cursor: 1,
		createdAt: 1000,
		direction: 'inbound',
		sender: ALICE,
		id: 'evt1',
		kind: 1,
		tags: [],
		content: '',
		...overrides
	};
}

describe('formatChatMessagePreviewText', () => {
	const token = `nostr:${nip19.npubEncode(ALICE)}`;

	it('renders mention tokens as @Name when hints cover the profile', () => {
		expect(formatChatMessagePreviewText(`hey ${token} look`, { [ALICE]: { name: 'alice' } })).toBe(
			'hey @alice look'
		);
	});

	it('falls back to a short npub for unknown profiles', () => {
		const shortNpub = `${nip19.npubEncode(ALICE).slice(0, 12)}…`;
		expect(formatChatMessagePreviewText(`hey ${token}`)).toBe(`hey @${shortNpub}`);
	});

	it('preserves plain text and links', () => {
		expect(formatChatMessagePreviewText('see https://cordn.net now')).toBe(
			'see https://cordn.net now'
		);
	});
});

describe('getChatMessagePreviewText', () => {
	function imetaTag(mime: string, filename: string, extra: string[] = []) {
		return [
			'imeta',
			'url https://cdn.example/x',
			`m ${mime}`,
			`filename ${filename}`,
			'x deadbeef',
			'n 00ff',
			'v 1',
			...extra
		];
	}

	it('labels media, appending the caption when present', () => {
		const tags = [imetaTag('image/jpeg', 'a.jpg')];
		expect(getChatMessagePreviewText(message({ tags, content: '' }))).toBe('📷 Photo');
		expect(getChatMessagePreviewText(message({ tags, content: '  look\n here ' }))).toBe(
			'📷 Photo: look here'
		);
		expect(
			getChatMessagePreviewText(message({ tags: [imetaTag('application/pdf', 'q3.pdf')] }))
		).toBe('📎 q3.pdf');
		expect(
			getChatMessagePreviewText(
				message({ tags: [imetaTag('audio/webm', 'note.webm', ['duration 1234'])] })
			)
		).toBe('🎤 Voice message');
	});

	it('renders system sentences with name tokens the card pipeline resolves', () => {
		const content = JSON.stringify({ systemKind: 'member-added', committer: ALICE, target: BOB });
		const preview = getChatMessagePreviewText(message({ kind: SYSTEM_MESSAGE_KIND, content }));
		const hints = { [ALICE]: { name: 'alice' }, [BOB]: { name: 'bob' } };
		expect(formatChatMessagePreviewText(preview, hints)).toBe('@alice added @bob to the group');
	});

	it('handles metadata-changed and unknown/corrupt system payloads', () => {
		const base = (payload: string) =>
			getChatMessagePreviewText(message({ kind: SYSTEM_MESSAGE_KIND, content: payload }));
		expect(base(JSON.stringify({ systemKind: 'metadata-changed', committer: ALICE }))).toContain(
			'changed group settings'
		);
		expect(
			base(
				JSON.stringify({
					systemKind: 'metadata-changed',
					committer: ALICE,
					detail: 'the group name'
				})
			)
		).toContain('changed the group name');
		expect(base('{not json')).toBe('');
	});

	it('passes plain text through and collapses whitespace', () => {
		expect(getChatMessagePreviewText(message({ content: 'hi\n  there ' }))).toBe('hi there');
	});
});
