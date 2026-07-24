import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { decodeProfileIdentifier } from '$lib/queries/profileIdentifierQueries';

// cordn's NIP-05 pubkey (static/.well-known/nostr.json), a stable real value
// to exercise encode/decode round-trips without inventing fixtures.
const HEX = 'c3c6d9bb385fd827cfdb45d933a1e8ccf2905be30467151ed5fe356a10a525e9';

describe('decodeProfileIdentifier (sync paths)', () => {
	it('decodes a lowercase hex pubkey', () => {
		const decoded = decodeProfileIdentifier(HEX);
		expect(decoded?.format).toBe('hex');
		expect(decoded?.pubkey).toBe(HEX);
		expect(decoded?.relayHints).toEqual([]);
	});

	it('decodes an uppercase hex pubkey and normalizes to lowercase', () => {
		const decoded = decodeProfileIdentifier(HEX.toUpperCase());
		expect(decoded?.format).toBe('hex');
		expect(decoded?.pubkey).toBe(HEX);
	});

	it('decodes an npub', () => {
		const npub = nip19.npubEncode(HEX);
		const decoded = decodeProfileIdentifier(npub);
		expect(decoded?.format).toBe('npub');
		expect(decoded?.pubkey).toBe(HEX);
	});

	it('decodes an nprofile and carries its relay hints', () => {
		const nprofile = nip19.nprofileEncode({
			pubkey: HEX,
			relays: ['wss://relay.cordn.net']
		});
		const decoded = decodeProfileIdentifier(nprofile);
		expect(decoded?.format).toBe('nprofile');
		expect(decoded?.pubkey).toBe(HEX);
		expect(decoded?.relayHints).toEqual(['wss://relay.cordn.net']);
	});

	it('returns null for inputs that require async resolution or are invalid', () => {
		// NIP-05 and shortnames are resolved async, not by the sync decoder.
		expect(decodeProfileIdentifier('user@cordn.net')).toBeNull();
		expect(decodeProfileIdentifier('cordn')).toBeNull();
		// Genuinely unusable.
		expect(decodeProfileIdentifier('')).toBeNull();
		expect(decodeProfileIdentifier('   ')).toBeNull();
		expect(decodeProfileIdentifier('not-a-key')).toBeNull();
		// Short hex is not a pubkey.
		expect(decodeProfileIdentifier('abc123')).toBeNull();
	});
});
