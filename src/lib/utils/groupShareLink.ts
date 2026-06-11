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
 * Encode group metadata (name + icon) as a compact base64 query param value.
 * Uses UTF-8 safe encoding so emoji and other non-Latin1 characters work.
 * Returns null if there is no name to encode.
 */
export function encodeGroupShareMetadata(metadata?: GroupShareMetadata): string | null {
	if (!metadata?.name) return null;
	const payload: GroupShareMetadata = { name: metadata.name };
	if (metadata.icon) payload.icon = metadata.icon;
	return bytesToBase64(textEncoder.encode(JSON.stringify(payload)));
}

/**
 * Decode a group metadata query parameter value.
 * Returns the decoded metadata or null if the value is invalid.
 */
export function decodeGroupMetadataQueryParam(param: string): GroupShareMetadata | null {
	const trimmed = param.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(textDecoder.decode(base64ToBytes(trimmed)));
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
		params.push(`c=${encodeURIComponent(nprofile)}`);
	}

	const encodedMeta = encodeGroupShareMetadata(data.metadata);
	if (encodedMeta) {
		params.push(`m=${encodeURIComponent(encodedMeta)}`);
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
