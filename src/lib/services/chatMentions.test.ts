import { describe, it, expect } from 'vitest';
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
