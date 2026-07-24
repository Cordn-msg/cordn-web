import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { matchesProfileSearch } from '$lib/components/chat/profileSearch';

const PUBKEY = '0000000000000000000000000000000000000000000000000000000000000001';
const NADDR = nip19.npubEncode(PUBKEY);

const hints = (
	override: Record<string, { name?: string; displayName?: string; nip05?: string }> = {}
) =>
	({
		[PUBKEY]: {
			name: 'Alice',
			displayName: 'Alice Smith',
			nip05: 'alice@cordn.net',
			...override[PUBKEY]
		}
	}) as never;

describe('matchesProfileSearch', () => {
	it('matches everything when the query is empty', () => {
		expect(matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: '' })).toBe(true);
		expect(matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: '   ' })).toBe(
			true
		);
	});

	it('matches the profile name case-insensitively', () => {
		expect(matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: 'alice' })).toBe(
			true
		);
		expect(matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: 'ALICE' })).toBe(
			true
		);
	});

	it('matches displayName, nip05, pubkey, and npub', () => {
		expect(matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: 'smith' })).toBe(
			true
		);
		expect(
			matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: 'cordn.net' })
		).toBe(true);
		expect(
			matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: PUBKEY.slice(0, 8) })
		).toBe(true);
		expect(
			matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: NADDR.slice(0, 12) })
		).toBe(true);
	});

	it('matches caller-supplied extraFields and ignores undefined ones', () => {
		expect(
			matchesProfileSearch({
				pubkey: PUBKEY,
				profileHints: hints(),
				search: 'last resort',
				extraFields: ['kp-ref-123', undefined, 'last resort']
			})
		).toBe(true);
		expect(
			matchesProfileSearch({
				pubkey: PUBKEY,
				profileHints: hints(),
				search: 'kp-ref-123'
			})
		).toBe(false);
	});

	it('returns false when nothing matches', () => {
		expect(
			matchesProfileSearch({ pubkey: PUBKEY, profileHints: hints(), search: 'zzz-nope' })
		).toBe(false);
	});

	it('works with no profile hint loaded (pubkey/npub still searchable)', () => {
		expect(
			matchesProfileSearch({ pubkey: PUBKEY, profileHints: {}, search: PUBKEY.slice(0, 8) })
		).toBe(true);
	});
});
