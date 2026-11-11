import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
	formatChatMessagePreviewText,
	formatChatNotificationBody,
	formatChatNotificationLine,
	getChatGroupTitlePersonPubkey,
	getChatMessagePreviewText
} from '$lib/components/chat/chatGroupDisplay';
import { clearChatPetname, setChatPetname } from '$lib/services/chatPetnames.svelte';
import { SYSTEM_MESSAGE_KIND } from '$lib/chat/kinds';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
import type { StoredChatGroup } from '$lib/services/chatGroups.svelte';

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

describe('formatChatNotificationBody', () => {
	it('never falls back to a raw pubkey', () => {
		expect(formatChatNotificationBody(message({ content: 'hi' }))).toBe('hi');
		expect(formatChatNotificationBody(message({ content: '   ' }))).toBe('New message');
	});
});

describe('formatChatNotificationLine', () => {
	const token = `nostr:${nip19.npubEncode(ALICE)}`;
	const hints = { [ALICE]: { name: 'alice' } };

	it('prefixes the sender in a group', () => {
		expect(formatChatNotificationLine(message({ content: 'hey' }), { profileHints: hints })).toBe(
			'alice: hey'
		);
	});

	it('leaves a 1:1 line bare — the title already names the peer', () => {
		expect(
			formatChatNotificationLine(message({ content: 'hey' }), {
				representativePubkey: ALICE,
				profileHints: hints
			})
		).toBe('hey');
	});

	it('never labels an unknown sender with a raw pubkey', () => {
		expect(formatChatNotificationLine(message({ content: 'hi' }))).toBe('hi');
		// Mentions of unknown profiles keep the npub shorthand: no name is knowable.
		expect(formatChatNotificationLine(message({ content: `hey ${token}` }))).toBe(
			`hey @${nip19.npubEncode(ALICE).slice(0, 12)}…`
		);
	});

	it('labels senders and mentions with a local petname', () => {
		setChatPetname(ALICE, 'mom');
		try {
			expect(
				formatChatNotificationLine(message({ content: `hey ${token}` }), {
					profileHints: { [ALICE]: { name: 'alice' } }
				})
			).toBe('mom: hey @mom');
		} finally {
			clearChatPetname(ALICE);
		}
	});
});

describe('getChatGroupTitlePersonPubkey', () => {
	const ME = 'cc'.repeat(32);

	function group(name?: string): StoredChatGroup {
		return { id: 'g1', metadata: name === undefined ? {} : { name } } as StoredChatGroup;
	}

	it('names the single other member of a 1:1', () => {
		expect(
			getChatGroupTitlePersonPubkey({ group: group(), activePubkey: ME, memberPubkeys: [ME, BOB] })
		).toBe(BOB);
		expect(
			getChatGroupTitlePersonPubkey({
				group: group(`:direct_chat:${BOB}`),
				activePubkey: ME,
				memberPubkeys: [ME, BOB]
			})
		).toBe(BOB);
	});

	it('has no single person for an explicit group name or a member summary', () => {
		expect(
			getChatGroupTitlePersonPubkey({
				group: group('Team'),
				activePubkey: ME,
				memberPubkeys: [ME, BOB]
			})
		).toBeUndefined();
		expect(
			getChatGroupTitlePersonPubkey({
				group: group(),
				activePubkey: ME,
				memberPubkeys: [ME, BOB, ALICE]
			})
		).toBeUndefined();
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
