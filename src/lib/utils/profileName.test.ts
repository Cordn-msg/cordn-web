import { describe, expect, test } from 'vitest';
import { profileDisplayName } from './profileName';

describe('profileDisplayName fallback order', () => {
	test('prefers name, then display_name, then nip05, then truncated npub', () => {
		const pubkey = 'ab'.repeat(32);
		expect(profileDisplayName({ name: 'A', display_name: 'B', nip05: 'a@b.c' }, pubkey)).toBe('A');
		expect(profileDisplayName({ display_name: 'B', nip05: 'a@b.c' }, pubkey)).toBe('B');
		expect(profileDisplayName({ nip05: 'a@b.c' }, pubkey)).toBe('a@b.c');
		expect(profileDisplayName(undefined, pubkey)).toMatch(/^npub1\w{7}…$/);
		expect(profileDisplayName(undefined)).toBeUndefined();
		// Blank strings fall through to the next tier, not rendered as names.
		expect(profileDisplayName({ name: '', display_name: 'B' }, pubkey)).toBe('B');
	});
});
