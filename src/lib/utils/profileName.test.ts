import { describe, expect, test } from 'vitest';
import { profileDisplayLabel, profileDisplayName, profileSelfName } from './profileName';
import { clearChatPetname, setChatPetname } from '$lib/services/chatPetnames.svelte';

const PUBKEY = 'c0'.repeat(32);

function clearPetname() {
	clearChatPetname(PUBKEY);
}

describe('profileDisplayName fallback order', () => {
	test('prefers name, then display_name, then nip05, then truncated npub', () => {
		expect(profileDisplayName({ name: 'A', display_name: 'B', nip05: 'a@b.c' }, PUBKEY)).toBe('A');
		expect(profileDisplayName({ display_name: 'B', nip05: 'a@b.c' }, PUBKEY)).toBe('B');
		expect(profileDisplayName({ nip05: 'a@b.c' }, PUBKEY)).toBe('a@b.c');
		expect(profileDisplayName(undefined, PUBKEY)).toMatch(/^npub1\w{7}…$/);
		expect(profileDisplayName(undefined)).toBeUndefined();
		// Blank strings fall through to the next tier, not rendered as names.
		expect(profileDisplayName({ name: '', display_name: 'B' }, PUBKEY)).toBe('B');
	});

	test('reads the deprecated camelCase displayName carried by hint objects', () => {
		expect(profileDisplayName({ displayName: 'Alice B.' }, PUBKEY)).toBe('Alice B.');
	});

	test('puts a local petname above every profile field', () => {
		setChatPetname(PUBKEY, '  Mom  ');
		expect(profileDisplayName({ name: 'Alice', nip05: 'a@b.c' }, PUBKEY)).toBe('Mom');
		clearPetname();

		// A petname works with no profile at all — an npub never becomes the label.
		setChatPetname(PUBKEY, 'Mom');
		expect(profileDisplayLabel(undefined, PUBKEY)).toBe('Mom');
		expect(profileDisplayName(undefined, PUBKEY)).toBe('Mom');
		clearPetname();
	});

	test('drops the petname on clear, back to the profile chain', () => {
		setChatPetname(PUBKEY, 'Mom');
		clearChatPetname(PUBKEY);
		expect(profileDisplayName({ name: 'Alice' }, PUBKEY)).toBe('Alice');
		expect(profileDisplayName(undefined, PUBKEY)).toMatch(/^npub1\w{7}…$/);
	});

	test('builds a sender label without ever inventing an npub', () => {
		expect(profileDisplayLabel(undefined, PUBKEY)).toBeUndefined();
		expect(profileDisplayLabel({ name: 'Alice' }, PUBKEY)).toBe('Alice');
	});

	test('normalizes and caps peer-authored profile names', () => {
		// A newline would add a line to the notification thread.
		expect(profileSelfName({ name: '  Alice \n\n B.  ' })).toBe('Alice B.');
		// Whitespace-only fields fall through to the next tier.
		expect(profileDisplayName({ name: '   ', display_name: 'B' }, PUBKEY)).toBe('B');
		expect(profileSelfName({ name: 'x'.repeat(200) })).toHaveLength(64);
	});

	test('keeps the self-declared name free of the petname', () => {
		setChatPetname(PUBKEY, 'Mom');
		expect(profileSelfName({ name: 'Alice' })).toBe('Alice');
		expect(profileSelfName(undefined)).toBeUndefined();
		clearPetname();
	});
});
