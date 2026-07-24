import type { ChatGroupProfileHints } from './chatGroupDisplay';
import { matchesProfileSearch } from './profileSearch';

/**
 * Key-package search: matches the pubkey/profile (via matchesProfileSearch)
 * plus the key-package reference and last-resort status. Thin adapter so the
 * directory and the invite dropdown share one core matcher with the member
 * multi-select.
 */
export function matchesKeyPackageSearch(input: {
	pubkey: string;
	keyPackageRef: string;
	isLastResort?: boolean;
	profileHints: ChatGroupProfileHints;
	search: string;
}) {
	return matchesProfileSearch({
		pubkey: input.pubkey,
		profileHints: input.profileHints,
		search: input.search,
		extraFields: [input.keyPackageRef, input.isLastResort ? 'last resort' : 'standard']
	});
}
