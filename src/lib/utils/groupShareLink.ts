import { goto } from '$app/navigation';
import { nip19 } from 'nostr-tools';
import { bytesToBase64, base64ToBytes } from 'ts-mls';
import { normalizePubKey } from '$lib/utils';
import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';

export interface GroupShareMetadata {
	name: string;
	icon?: string;
}

export interface GroupShareLinkData {
	groupId: string;
	coordinatorKey: string;
	relays?: string[];
	metadata?: GroupShareMetadata;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * base64url encode (URL-safe charset `A-Za-z0-9-_`, no padding) so the `m=`
 * value survives every transport unencoded: no `+`/`/`/`=` to be mangled by
 * chat clients, email line-wrapping, or percent-decoding.
 */
function toBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode base64url OR legacy standard base64 (`+`/`/`/`=`), so links shared
 * before the base64url switch keep working.
 */
function fromBase64Url(value: string): Uint8Array {
	const standard = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
	return base64ToBytes(padded);
}

/**
 * Encode group metadata (name + icon) as a compact base64url query param value.
 * Uses UTF-8 safe encoding so emoji and other non-Latin1 characters work.
 * Returns null if there is no name to encode.
 */
export function encodeGroupShareMetadata(metadata?: GroupShareMetadata): string | null {
	if (!metadata?.name) return null;
	const payload: GroupShareMetadata = { name: metadata.name };
	if (metadata.icon) payload.icon = metadata.icon;
	return toBase64Url(textEncoder.encode(JSON.stringify(payload)));
}

/**
 * Decode a group metadata query parameter value.
 * Returns the decoded metadata or null if the value is invalid.
 */
export function decodeGroupMetadataQueryParam(param: string): GroupShareMetadata | null {
	const trimmed = param.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(textDecoder.decode(fromBase64Url(trimmed)));
		if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.name) {
			const result: GroupShareMetadata = { name: parsed.name };
			if (typeof parsed.icon === 'string' && parsed.icon) result.icon = parsed.icon;
			return result;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Encode a group ID and coordinator info into a shareable URL path.
 * The coordinator info is encoded as an nprofile nip19 identifier
 * in the `c` query parameter, which includes the coordinator pubkey
 * and optional relay hints. The `c` param is omitted for groups
 * hosted on the default coordinator.
 *
 * Group metadata (name + icon) is encoded as a base64 JSON blob in
 * the `m` query parameter, so shareable links render a minimal
 * group card. The `m` param is omitted when there is no group name.
 */
export function encodeGroupShareLink(data: GroupShareLinkData): string {
	const params: string[] = [];

	const isDefaultCoordinator =
		normalizePubKey(data.coordinatorKey) === normalizePubKey(DEFAULT_CHAT_COORDINATOR_PUBKEY);

	if (!isDefaultCoordinator) {
		const nprofile = nip19.nprofileEncode({
			pubkey: data.coordinatorKey,
			relays: data.relays ?? []
		});
		// nprofile (bech32) is URL-safe, so no encoding needed.
		params.push(`c=${nprofile}`);
	}

	const encodedMeta = encodeGroupShareMetadata(data.metadata);
	if (encodedMeta) {
		// base64url charset is URL-safe, so no encoding needed.
		params.push(`m=${encodedMeta}`);
	}

	const query = params.length > 0 ? `?${params.join('&')}` : '';
	return `/chat/${data.groupId}${query}`;
}

/**
 * Decode a coordinator query parameter value.
 * Handles both hex pubkeys and nprofile nip19 identifiers.
 * Returns { coordinatorKey, relays? } or null if the value is invalid.
 */
export function decodeCoordinatorQueryParam(param: string): {
	coordinatorKey: string;
	relays?: string[];
} | null {
	const trimmed = param.trim();
	if (!trimmed) return null;

	// Try hex pubkey first
	if (/^[0-9a-f]{64}$/i.test(trimmed)) {
		return { coordinatorKey: normalizePubKey(trimmed) };
	}

	// Try decoding as nip19 (nprofile or npub)
	try {
		const decoded = nip19.decode(trimmed);
		if (decoded.type === 'nprofile') {
			return {
				coordinatorKey: normalizePubKey(decoded.data.pubkey),
				relays: decoded.data.relays?.length ? decoded.data.relays : undefined
			};
		}
		if (decoded.type === 'npub') {
			return { coordinatorKey: normalizePubKey(decoded.data) };
		}
	} catch {
		// Fall through to null
	}

	return null;
}

/**
 * A navigation target resolved from a user-entered share string.
 *  - `internal`: an app-relative path to goto() (relative link or bare group id).
 *  - `external`: an absolute http(s) URL whose origin is resolved at goto time.
 */
export type ParsedShareTarget =
	| { kind: 'internal'; path: string }
	| { kind: 'external'; url: string };

/**
 * Parse a pasted/typed string into a navigation target for the join/share flow.
 *
 * Accepts:
 *  - an absolute URL (https://host/path?…) → external, origin-resolved later;
 *  - an app-relative path (/chat/<id>?…) → internal;
 *  - a bare group id → internal /chat/<id> on the default coordinator.
 *
 * Bare ids are intentionally permissive (no format check): the [id] route
 * renders a "not a member / request to join" card for unknown ids rather than
 * hard-rejecting, which is the friendlier behavior for a mistyped id.
 */
export function parseShareTarget(raw: string): ParsedShareTarget | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	if (/^https?:\/\//i.test(trimmed)) {
		try {
			return { kind: 'external', url: new URL(trimmed).toString() };
		} catch {
			return null;
		}
	}

	if (trimmed.startsWith('/')) {
		return { kind: 'internal', path: trimmed };
	}

	return { kind: 'internal', path: `/chat/${encodeURIComponent(trimmed)}` };
}

/**
 * Drop malformed query params from a navigation path so a single corrupted
 * value can't sink the whole link. Only `m=` (cosmetic name/icon preview) is
 * healed by dropping; a malformed `c=` is intentionally left intact because
 * silently dropping it would route a join request to the default coordinator
 * (the [id] route instead surfaces a clear error for a bad `c=`).
 */
export function healShareQuery(path: string): string {
	const queryIndex = path.indexOf('?');
	if (queryIndex === -1) return path;
	const hashIndex = path.indexOf('#', queryIndex);
	const base = path.slice(0, queryIndex);
	const search =
		hashIndex === -1 ? path.slice(queryIndex + 1) : path.slice(queryIndex + 1, hashIndex);
	const hash = hashIndex === -1 ? '' : path.slice(hashIndex);

	const params = new URLSearchParams(search);
	if (params.has('m') && !decodeGroupMetadataQueryParam(params.get('m') ?? '')) {
		params.delete('m');
	}
	const query = params.toString();
	return `${base}${query ? `?${query}` : ''}${hash}`;
}

/**
 * Navigate to a target from parseShareTarget(). Same-origin absolute URLs go
 * through goto() in-app; cross-origin URLs open in a new tab. The [id] route
 * owns membership checks, login gating, and coordinator registration.
 */
export async function gotoShareTarget(target: ParsedShareTarget): Promise<void> {
	if (target.kind === 'internal') {
		// Runtime-resolved path from user input; resolve() cannot apply.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(healShareQuery(target.path));
		return;
	}

	if (typeof window !== 'undefined') {
		try {
			const url = new URL(target.url);
			if (url.origin === window.location.origin) {
				// Runtime-resolved path from pasted input; resolve() cannot apply.
				// eslint-disable-next-line svelte/no-navigation-without-resolve
				await goto(healShareQuery(`${url.pathname}${url.search}${url.hash}`));
				return;
			}
		} catch {
			// Fall through to opening externally.
		}
		window.open(target.url, '_blank', 'noopener,noreferrer');
	}
}
