import { nip19 } from 'nostr-tools';
import type { ProfileContent } from 'applesauce-core/helpers';
import { getChatPetname } from '$lib/services/chatPetnames.svelte';

/**
 * One display-name policy for every person surface (message bubbles, mentions,
 * group titles, cards, search, notifications):
 *
 *   local petname → name → display_name → nip05
 *
 * `profileSelfName` is the profile-only chain (the identity the person claims
 * for themselves). `profileDisplayLabel` adds the petname and never invents a
 * fallback — notification authorship uses it so an unknown sender is announced
 * by no name at all, never by a raw pubkey. `profileDisplayName` is the
 * UI-level resolver that finally abbreviates the npub.
 *
 * Hints objects in the app carry the deprecated camelCase `displayName` (see
 * `useProfileHints`), so both spellings are read.
 */
const MAX_PROFILE_NAME_LENGTH = 64;

/** Profile fields are peer-authored: collapse whitespace (a newline would add a
 *  notification line) and cap the length before any of them becomes a label. */
function cleanName(value: string | undefined): string | undefined {
	const name = value?.replace(/\s+/g, ' ').trim().slice(0, MAX_PROFILE_NAME_LENGTH);
	return name || undefined;
}

export function profileSelfName(profile: ProfileContent | undefined): string | undefined {
	return (
		cleanName(profile?.name) ??
		cleanName(profile?.display_name) ??
		cleanName(profile?.displayName) ??
		cleanName(profile?.nip05)
	);
}

export function profileDisplayLabel(
	profile: ProfileContent | undefined,
	pubkey?: string
): string | undefined {
	return (pubkey ? getChatPetname(pubkey) : undefined) ?? profileSelfName(profile);
}

export function profileDisplayName(
	profile: ProfileContent | undefined,
	pubkey?: string
): string | undefined {
	const label = profileDisplayLabel(profile, pubkey);
	if (label) return label;
	return pubkey ? `${nip19.npubEncode(pubkey).slice(0, 12)}…` : undefined;
}
