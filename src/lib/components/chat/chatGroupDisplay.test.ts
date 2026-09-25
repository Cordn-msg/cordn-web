import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { formatChatMessagePreviewText } from '$lib/components/chat/chatGroupDisplay';

const ALICE = 'aa'.repeat(32);

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
