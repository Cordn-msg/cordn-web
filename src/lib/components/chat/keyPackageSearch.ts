import { nip19 } from 'nostr-tools';
import type { ChatGroupProfileHints } from './chatGroupDisplay';

export type KeyPackageProfileHints = ChatGroupProfileHints;

export function matchesKeyPackageSearch(input: {
	pubkey: string;
	keyPackageRef: string;
	isLastResort?: boolean;
	profileHints: KeyPackageProfileHints;
	search: string;
}) {
	const query = input.search.trim().toLowerCase();
	if (!query) return true;

	const profile = input.profileHints[input.pubkey];
	const npub = nip19.npubEncode(input.pubkey);
	const values = [
		profile?.name,
		profile?.displayName,
		profile?.nip05,
		input.pubkey,
		npub,
		input.keyPackageRef,
		input.isLastResort ? 'last resort' : 'standard'
	].filter((value): value is string => Boolean(value));

	return values.some((value) => value.toLowerCase().includes(query));
}
