import { nip19 } from 'nostr-tools';
import type { ProfileContent } from 'applesauce-core/helpers';

/**
 * Single display-name fallback chain for kind-0 profiles:
 * name → display_name → nip05 → truncated npub. Shared by ProfileCard,
 * system-message name chips, and coordinator label resolution so every
 * surface degrades identically. Returns undefined only when there is
 * neither profile data nor a pubkey to abbreviate.
 */
export function profileDisplayName(
	profile: ProfileContent | undefined,
	pubkey?: string
): string | undefined {
	if (profile?.name) return profile.name;
	if (profile?.display_name) return profile.display_name;
	if (profile?.nip05) return profile.nip05;
	if (pubkey) return `${nip19.npubEncode(pubkey).slice(0, 12)}…`;
	return undefined;
}
