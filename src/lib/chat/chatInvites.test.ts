import { describe, expect, it } from 'vitest';
import { encodeGroupRef } from '@cordn/core';
import { nip19 } from 'nostr-tools';
import { parseChatProfileMentions } from '$lib/services/chatMentions';
import {
	MAX_CHAT_INVITES_PER_MESSAGE,
	classifyChatInviteHref,
	extractChatInvites,
	tidyChatBodyText
} from '$lib/chat/chatInvites';

const COORD = '92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5';
const CODE = encodeGroupRef({ gid: 'garden-1234', coordinatorPubkey: COORD });
const GROUP_URL = `https://cordn.net/chat/${CODE}`;
const NPUB = nip19.npubEncode(COORD);

function linksOf(content: string) {
	return extractChatInvites(parseChatProfileMentions(content));
}

describe('classifyChatInviteHref', () => {
	it('cards a bare cordn1 code', () => {
		const invite = classifyChatInviteHref(CODE);
		expect(invite?.kind).toBe('group');
		if (invite?.kind === 'group') {
			expect(invite.gid).toBe('garden-1234');
			expect(invite.coordinatorPubkey).toBe(COORD);
			expect(invite.target).toEqual({ type: 'chat' });
		}
	});

	it('cards a group share URL with ?m= metadata and /e/<id> target', () => {
		const url = `https://cordn.net/chat/${CODE}/e/abc123?m=eyJuYW1lIjoibmFtZSJ9`;
		const invite = classifyChatInviteHref(url);
		if (invite?.kind !== 'group') throw new Error('expected group invite');
		expect(invite.gid).toBe('garden-1234');
		expect(invite.name).toBe('name'); // base64url({"name":"name"})
		expect(invite.target).toEqual({ type: 'message', eventId: 'abc123' });
	});

	it('cards a coordinator share and a profile link', () => {
		const coord = classifyChatInviteHref(
			`https://cordn.net/chat/coordinators?c=${NPUB}&label=Home`
		);
		if (coord?.kind !== 'coordinator') throw new Error('expected coordinator invite');
		expect(coord.pubkey).toBe(COORD);
		expect(coord.label).toBe('Home');

		const profile = classifyChatInviteHref(`https://cordn.net/p/${NPUB}`);
		if (profile?.kind !== 'profile') throw new Error('expected profile invite');
		expect(profile.pubkey).toBe(COORD);
	});

	it('accepts the legacy bare-gid form on known hosts only', () => {
		expect(classifyChatInviteHref('https://cordn.net/chat/my-gid-123')?.kind).toBe('group');
		expect(classifyChatInviteHref('https://example.com/chat/my-gid-123')).toBeNull();
		expect(classifyChatInviteHref('https://cordn.net/chat/cordn1invalid')).toBeNull();
	});

	it('never cards app pages or foreign links', () => {
		expect(classifyChatInviteHref('https://cordn.net/chat/news')).toBeNull();
		expect(classifyChatInviteHref('https://cordn.net/chat/config/media')).toBeNull();
		expect(classifyChatInviteHref('https://cordn.net/why')).toBeNull();
		expect(classifyChatInviteHref('https://example.com/chat/cordn1')).toBeNull();
		expect(classifyChatInviteHref('https://cordn.net/docs')).toBeNull();
		expect(classifyChatInviteHref(`https://cordn.net/p/name@cordn.net`)).toBeNull();
	});
});

describe('extractChatInvites', () => {
	it('finds invites in order, once each, and ignores non-invite links', () => {
		const content = `join (${GROUP_URL}), again ${GROUP_URL}. bare ${CODE} and docs https://cordn.net/docs`;
		const { invites, linkTexts } = linksOf(content);
		// The URL in parentheses: our tokenizer keeps the ( out; both texts dedup to one.
		expect(invites.map((i) => i.kind)).toEqual(['group', 'group']);
		expect(linkTexts[0]).toBe(GROUP_URL);
		expect(linkTexts[1]).toBe(CODE);
	});

	it('caps at the limit', () => {
		const many = Array.from(
			{ length: MAX_CHAT_INVITES_PER_MESSAGE + 2 },
			(_, i) => `https://cordn.net/chat/gid-${i}-pad`
		).join(' ');
		expect(linksOf(many).invites).toHaveLength(MAX_CHAT_INVITES_PER_MESSAGE);
	});

	it('returns nothing for cordn-free text', () => {
		expect(linksOf('see https://example.com/chat/x and hi').invites).toEqual([]);
	});
});

describe('tidyChatBodyText', () => {
	it('removes the links and tidies the spaces left behind', () => {
		const coord = `https://cordn.net/chat/coordinators?c=${NPUB}`;
		expect(
			tidyChatBodyText(`Come say hi: ${GROUP_URL}\nand  bring ${coord} cake`, [GROUP_URL, coord])
		).toBe('Come say hi:\nand bring cake');
	});

	it('leaves link-only messages empty', () => {
		expect(tidyChatBodyText(GROUP_URL, [GROUP_URL])).toBe('');
		expect(tidyChatBodyText(`  ${CODE}  `, [CODE])).toBe('');
	});

	it('collapses double spaces on every line, like Staircase', () => {
		expect(
			tidyChatBodyText(
				`a  b
join ${CODE}`,
				[CODE]
			)
		).toBe('a b\njoin');
	});
});
