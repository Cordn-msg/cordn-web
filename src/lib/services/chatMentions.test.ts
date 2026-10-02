import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { chatMessageReferencesPubkey, parseChatProfileMentions } from '$lib/services/chatMentions';
import { encodeGroupRef } from '@cordn/core';

const COORD = '92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5';

describe('parseChatProfileMentions cordn1 recognition', () => {
	it('tokenizes a bare cordn1 ref as a link', () => {
		const code = encodeGroupRef({ gid: 'g', coordinatorPubkey: COORD });
		const parts = parseChatProfileMentions(`join ${code} please`);
		const links = parts.filter((p) => p.type === 'link');
		expect(links).toHaveLength(1);
		if (links[0].type === 'link') expect(links[0].href).toBe(code);
	});

	it('keeps a cordn1 inside a URL as part of the URL (no double-link)', () => {
		const code = encodeGroupRef({ gid: 'g', coordinatorPubkey: COORD });
		const parts = parseChatProfileMentions(`see https://cordn.net/chat/${code}`);
		const links = parts.filter((p) => p.type === 'link');
		// The whole URL is one link; the embedded cordn1 must not become a second.
		expect(links).toHaveLength(1);
		if (links[0].type === 'link') {
			expect(links[0].href).toBe(`https://cordn.net/chat/${code}`);
		}
	});

	it('leaves a non-checksummed cordn1-looking token as plain text', () => {
		// 'cordn1garbage' matches the loose charset but fails isGroupRef length/shape
		// validation only after decode; here isGroupRef rejects short tails, so no link.
		const parts = parseChatProfileMentions('see cordn1xyz');
		expect(parts.filter((p) => p.type === 'link')).toHaveLength(0);
	});
});

describe('parseChatProfileMentions embedded events', () => {
	it('tokenizes a bare nevent as an event part with relay-hint pointer', () => {
		const pointer = {
			id: 'ab'.repeat(32),
			relays: ['wss://relay.example'],
			author: 'cd'.repeat(32)
		};
		const code = nip19.neventEncode(pointer);
		const parts = parseChatProfileMentions(`look ${code} please`);
		const events = parts.filter((p) => p.type === 'event');
		expect(events).toHaveLength(1);
		if (events[0].type === 'event') {
			expect(events[0].pointer).toEqual(pointer);
			expect(events[0].text).toBe(code);
		}
	});

	it('keeps the nostr: prefix optional for events', () => {
		const code = nip19.noteEncode('ab'.repeat(32));
		const bare = parseChatProfileMentions(`x ${code}`).filter((p) => p.type === 'event');
		const prefixed = parseChatProfileMentions(`x nostr:${code}`).filter((p) => p.type === 'event');
		expect(bare).toHaveLength(1);
		expect(prefixed).toHaveLength(1);
	});

	it('decodes naddr to an address pointer', () => {
		const pointer = { kind: 30023, pubkey: 'ab'.repeat(32), identifier: 'hello' };
		const code = nip19.naddrEncode(pointer);
		const parts = parseChatProfileMentions(`read nostr:${code}`);
		const events = parts.filter((p) => p.type === 'event');
		expect(events).toHaveLength(1);
		if (events[0].type === 'event') {
			// toMatchObject: nip19 decode adds an empty relays array when none were encoded.
			expect(events[0].pointer).toMatchObject(pointer);
		}
	});

	it('keeps a bech32 inside a URL as part of the link', () => {
		const code = nip19.noteEncode('ab'.repeat(32));
		const parts = parseChatProfileMentions(`see https://njump.me/${code} now`);
		const links = parts.filter((p) => p.type === 'link');
		const events = parts.filter((p) => p.type === 'event');
		expect(links).toHaveLength(1);
		expect(events).toHaveLength(0);
		if (links[0].type === 'link') {
			expect(links[0].href).toBe(`https://njump.me/${code}`);
		}
	});

	it('leaves invalid bech32 as plain text', () => {
		const parts = parseChatProfileMentions('see nevent1notvalid');
		expect(parts.filter((p) => p.type === 'event')).toHaveLength(0);
	});

	it('still requires the nostr: prefix for profiles (unchanged)', () => {
		const npub = nip19.npubEncode('ab'.repeat(32));
		const parts = parseChatProfileMentions(`hi ${npub}`);
		expect(parts.filter((p) => p.type === 'profile')).toHaveLength(0);
	});
});

describe('chatMessageReferencesPubkey', () => {
	const target = 'dd'.repeat(32);

	it('matches a p tag case-insensitively', () => {
		expect(chatMessageReferencesPubkey([['p', 'DD'.repeat(32)]], target)).toBe(true);
		expect(chatMessageReferencesPubkey([['p', 'ee'.repeat(32)]], target)).toBe(false);
		expect(chatMessageReferencesPubkey([['e', target]], target)).toBe(false);
	});

	it('ignores malformed p tags instead of throwing', () => {
		// A peer can put any string in a p tag; the unread/mention scan must not
		// throw (it runs inside sidebar + attention deriveds).
		expect(() =>
			chatMessageReferencesPubkey(
				[
					['p', 'not-hex'],
					['p', '']
				],
				target
			)
		).not.toThrow();
		expect(
			chatMessageReferencesPubkey(
				[
					['p', 'not-hex'],
					['p', '']
				],
				target
			)
		).toBe(false);
	});
});
