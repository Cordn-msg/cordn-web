import { nip19 } from 'nostr-tools';
import type { ChatGroupProfileHints } from './chatGroupDisplay';

export interface ProfileSearchInput {
	pubkey: string;
	profileHints: ChatGroupProfileHints;
	search: string;
	/** Extra caller-specific tokens (key-package ref, status flags, labels). Falsy entries are ignored. */
	extraFields?: (string | undefined)[];
}

/**
 * Match a pubkey and its profile metadata (name, display name, NIP-05) plus
 * caller-supplied extra tokens against a search query. Empty query matches all.
 * Shared by the key-package directory, the invite dropdown, and the member
 * multi-select so they never drift on which fields are searchable.
 */
export function matchesProfileSearch(input: ProfileSearchInput): boolean {
	const query = input.search.trim().toLowerCase();
	if (!query) return true;

	const profile = input.profileHints[input.pubkey];
	const values = [
		profile?.name,
		profile?.displayName,
		profile?.nip05,
		input.pubkey,
		nip19.npubEncode(input.pubkey),
		...(input.extraFields ?? [])
	].filter((value): value is string => Boolean(value));

	return values.some((value) => value.toLowerCase().includes(query));
}
