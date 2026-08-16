import { browser } from '$app/environment';
import { nip19 } from 'nostr-tools';
import { isNip05, queryProfile } from 'nostr-tools/nip05';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { normalizePubKey } from '$lib/utils';
import { PUBLIC_WEB_ORIGIN } from '$lib/utils/appOrigin';

/**
 * The domain shortnames resolve against. Always the canonical `cordn.net`
 * (where `static/.well-known/nostr.json` is served), even on native — the
 * Capacitor WebView runs on `https://localhost`, which has no nostr.json, so
 * `window.location.hostname` can't be used here (unlike the web-only
 * contextvm-site reference, which keys off the live hostname).
 */
const DEFAULT_NIP05_DOMAIN = new URL(PUBLIC_WEB_ORIGIN).hostname;

/** User-supplied hex may be either case; normalizePubKey lowercases it. */
const HEX_PUBKEY_PATTERN = /^[0-9a-fA-F]{64}$/;

export type ProfileIdentifierFormat = 'hex' | 'npub' | 'nprofile' | 'nip05' | 'shortname';

export interface DecodedProfileIdentifier {
	pubkey: string;
	relayHints: string[];
	format: ProfileIdentifierFormat;
}

export interface ResolvedProfileIdentifier extends DecodedProfileIdentifier {
	original: string;
	nip05?: string;
	domain?: string;
}

/**
 * Synchronously decode hex / npub / nprofile identifiers. Returns null for
 * anything that needs network resolution (NIP-05, shortname) or is invalid.
 */
export function decodeProfileIdentifier(identifier: string): DecodedProfileIdentifier | null {
	const value = identifier.trim();
	if (!value) return null;

	if (HEX_PUBKEY_PATTERN.test(value)) {
		return { pubkey: normalizePubKey(value), relayHints: [], format: 'hex' };
	}

	try {
		const decoded = nip19.decode(value);
		if (decoded.type === 'npub') {
			return { pubkey: normalizePubKey(decoded.data), relayHints: [], format: 'npub' };
		}
		if (decoded.type === 'nprofile') {
			return {
				pubkey: normalizePubKey(decoded.data.pubkey),
				relayHints: decoded.data.relays ?? [],
				format: 'nprofile'
			};
		}
	} catch {
		// not a bech32 (npub/nprofile) identifier — fall through to null
	}

	return null;
}

/** Build a `name@cordn.net` shortname NIP-05 when the input has no `@`. */
function toShortnameNip05(identifier: string): string | null {
	const value = identifier.trim();
	if (!value || value.includes('@')) return null;
	const candidate = `${value}@${DEFAULT_NIP05_DOMAIN}`;
	return isNip05(candidate) ? candidate : null;
}

/**
 * Resolve any profile identifier to a pubkey. Hex / npub / nprofile are
 * decoded synchronously; full NIP-05 addresses (`user@domain`) and bare
 * shortnames (`cordn` → `cordn@cordn.net`) are resolved via
 * `.well-known/nostr.json`. Returns null for inputs that are neither
 * decodable nor a valid NIP-05/shortname; throws when a NIP-05 lookup runs
 * but returns no valid pubkey.
 */
async function resolveProfileIdentifier(
	identifier: string
): Promise<ResolvedProfileIdentifier | null> {
	const value = identifier.trim();
	const decoded = decodeProfileIdentifier(value);
	if (decoded) return { ...decoded, original: value };

	const nip05 = isNip05(value) ? value : toShortnameNip05(value);
	if (!nip05) return null;

	const pointer = await queryProfile(nip05);
	const pubkey = pointer?.pubkey;
	if (!pubkey || !HEX_PUBKEY_PATTERN.test(pubkey)) {
		throw new Error(`No valid public key found for ${nip05}`);
	}

	const [, name = '_', domain = ''] = nip05.match(/^(?:([^@]+)@)?([^@]+)$/) ?? [];
	return {
		original: value,
		pubkey: normalizePubKey(pubkey),
		relayHints: pointer?.relays ?? [],
		format: isNip05(value) ? 'nip05' : 'shortname',
		nip05: `${name}@${domain}`,
		domain
	};
}

export function profileIdentifierQueryOptions(identifier: string) {
	const trimmed = identifier.trim();
	return {
		queryKey: chatQueryKeys.profileIdentifier(trimmed),
		queryFn: () => resolveProfileIdentifier(trimmed),
		// Sync-decodable identifiers (hex/npub/nprofile) never need a fetch.
		enabled: browser && trimmed.length > 0 && decodeProfileIdentifier(trimmed) === null,
		staleTime: 5 * 60 * 1000,
		// Fail fast: a typo'd NIP-05 shouldn't retry three times before surfacing.
		retry: false
	};
}
