import { describe, it, expect } from 'vitest';
import { parseChatProfileMentions } from '$lib/services/chatMentions';
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
