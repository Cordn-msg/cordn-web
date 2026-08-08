import { goto } from '$app/navigation';
import { nip19 } from 'nostr-tools';
import { bytesToBase64, base64ToBytes } from 'ts-mls';
import { encodeGroupRef, decodeGroupRef, isGroupRef, type GroupRef } from '@cordn/core';
import { normalizePubKey } from '$lib/utils';
import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
import { PUBLIC_WEB_ORIGIN, isAppOrigin } from './appOrigin';
import { openExternal } from '$lib/services/nativeShims';

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
 * Build the app share path for a group using the cordn1 bech32 group reference
 * (reference/cordn/spec/applications/group-ref.md). The coordinator pubkey and
 * relay hints are packed INTO the cordn1 string, so there is no `?c=`. Rich
 * share-card metadata (name + icon) is still carried as base64url in `?m=`,
 * since the group reference itself carries only protocol coordinates.
 *
 * The coordinator is always included (spec §4.2 recommends it for cross-client
 * share links) — portability beats saving a few characters, and it drops the
 * "is this the default coordinator?" branch that made old links ambiguous.
 *
 * ponytail: path-based (`/chat/cordn1…`) rather than fragment (`#cordn1…`) even
 * though spec §6 prefers a fragment for log-privacy. This is a client-routed SPA
 * (no server logs the path) and path-based reuses the existing `[id]` route,
 * the join-card logic, and the verified `cordn.net/chat` App Link.
 */
export function buildGroupSharePath(data: GroupShareLinkData): string {
	const ref: GroupRef = {
		gid: data.groupId,
		coordinatorPubkey: normalizePubKey(data.coordinatorKey),
		...(data.relays && data.relays.length > 0 ? { relays: data.relays } : {})
	};
	const code = encodeGroupRef(ref);
	const encodedMeta = encodeGroupShareMetadata(data.metadata);
	// base64url charset is URL-safe; cordn1 (bech32) is URL-safe — no encoding.
	const query = encodedMeta ? `?m=${encodedMeta}` : '';
	return `/chat/${code}${query}`;
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

export interface ResolvedGroupLocator {
	gid: string;
	/** Coordinator to use for fetches/joins. Defaults to the public coordinator
	 *  when the link carried none; '' only when the link is malformed. */
	coordinatorKey: string;
	/** True when the link explicitly carried a coordinator (cordn1 type 1 or a
	 *  legacy `?c=`). Gates auto-registration so default-coordinator short links
	 *  don't upsert. */
	coordinatorProvided: boolean;
	relays?: string[];
	coordinatorError: string;
	shareMetadata: GroupShareMetadata | null;
}

/**
 * Resolve the `[id]` route param (+ query) into the gid + coordinator used to
 * look the group up and drive the join flow. Accepts both the canonical cordn1
 * group reference in the path AND, for back-compat, a bare gid with a legacy
 * `?c=` coordinator hint.
 *
 * A cordn1 ref that fails checksum/structure is NOT treated as a bare gid
 * (spec §5: MUST NOT silently fall back) — it surfaces as a locator error with
 * an empty gid so the route can show a clear message.
 */
export function resolveGroupLocator(
	idParam: string,
	searchParams: URLSearchParams
): ResolvedGroupLocator {
	const mValue = searchParams.get('m')?.trim();
	const shareMetadata = mValue ? decodeGroupMetadataQueryParam(mValue) : null;

	if (isGroupRef(idParam)) {
		try {
			const ref = decodeGroupRef(idParam);
			return {
				gid: ref.gid,
				coordinatorKey: ref.coordinatorPubkey ?? DEFAULT_CHAT_COORDINATOR_PUBKEY,
				coordinatorProvided: ref.coordinatorPubkey !== undefined,
				...(ref.relays && ref.relays.length > 0 ? { relays: ref.relays } : {}),
				coordinatorError: '',
				shareMetadata
			};
		} catch {
			return {
				gid: '',
				coordinatorKey: '',
				coordinatorProvided: false,
				coordinatorError: 'This group link is malformed. Ask for a new link.',
				shareMetadata
			};
		}
	}

	// Legacy / internal form: bare gid in the path, coordinator from `?c=`.
	const coordinatorParam = searchParams.get('c')?.trim() ?? '';
	const coordinatorQuery = coordinatorParam ? decodeCoordinatorQueryParam(coordinatorParam) : null;
	const coordinatorKey = !coordinatorParam
		? DEFAULT_CHAT_COORDINATOR_PUBKEY
		: (coordinatorQuery?.coordinatorKey ?? '');
	const coordinatorError =
		coordinatorParam && !coordinatorQuery
			? 'This invite link has a malformed coordinator. Ask for a new link.'
			: '';
	return {
		gid: idParam,
		coordinatorKey,
		coordinatorProvided: Boolean(coordinatorParam && coordinatorQuery),
		...(coordinatorQuery?.relays && coordinatorQuery.relays.length > 0
			? { relays: coordinatorQuery.relays }
			: {}),
		coordinatorError,
		shareMetadata
	};
}

/**
 * Resolve the gid of the group currently reflected in a `/chat/<id>` path (or
 * `''` when not on a group route). The `[id]` segment may be a `cordn1` ref or a
 * bare gid — both decode to the same gid — so callers (tab title, notification
 * suppression, sidebar active state) compare by gid and stay correct under
 * either URL form, including `/e` / `/info` sub-paths.
 */
export function activeGroupId(
	pathname: string,
	searchParams: URLSearchParams = new URLSearchParams()
): string {
	if (!pathname.startsWith('/chat/')) return '';
	const segment = pathname.split('/')[2];
	if (!segment) return '';
	return resolveGroupLocator(segment, searchParams).gid;
}

/** Host users paste bare (cordn.net/…). The canonical public host, since dev
 *  origins are localhost and won't be pasted. */
const APP_HOST = (() => {
	try {
		return new URL(PUBLIC_WEB_ORIGIN).host;
	} catch {
		return 'cordn.net';
	}
})();

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a bare "cordn.net/…" string (no scheme). Requires a `/` so the bare
 *  host alone isn't mistaken for a path. */
function looksLikeBareAppHostUrl(value: string): boolean {
	return new RegExp(`^${escapeRegExp(APP_HOST)}(?=/|$)`, 'i').test(value) && value.includes('/');
}

/**
 * A navigation target resolved from a user-entered share string.
 *  - `internal`: an app-relative path to goto() (cordn1 ref, relative link, or bare group id).
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

	// Bare cordn1 group reference (no URL wrapper), possibly with a trailing
	// ?m=… metadata query copied from a full share link → internal nav. Split any
	// query/hash off FIRST: isGroupRef rejects the `?` (not bech32), and without
	// splitting the bare-id fallback below would encodeURIComponent the `?m=`
	// into the id segment (mangling metadata into the gid).
	const refEnd = trimmed.search(/[?#]/);
	const refPart = refEnd === -1 ? trimmed : trimmed.slice(0, refEnd);
	const queryHash = refEnd === -1 ? '' : trimmed.slice(refEnd);
	if (isGroupRef(refPart)) {
		return { kind: 'internal', path: `/chat/${refPart}${queryHash}` };
	}

	if (/^https?:\/\//i.test(trimmed)) {
		try {
			return { kind: 'external', url: new URL(trimmed).toString() };
		} catch {
			return null;
		}
	}

	// Bare app-host URL without a scheme (cordn.net/…) → internal, so pasting
	// "cordn.net/chat/cordn1…" routes in-app instead of a new tab or a misrouted
	// /chat/cordn.net/… path. Full https://cordn.net/… links are classified as
	// external here and reconciled to internal by gotoShareTarget's origin check.
	if (looksLikeBareAppHostUrl(trimmed)) {
		try {
			const url = new URL(`https://${trimmed}`);
			return { kind: 'internal', path: `${url.pathname}${url.search}${url.hash}` };
		} catch {
			// Fall through to bare-id handling.
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
			if (isAppOrigin(url.origin)) {
				// Runtime-resolved path from pasted input; resolve() cannot apply.
				// eslint-disable-next-line svelte/no-navigation-without-resolve
				await goto(healShareQuery(`${url.pathname}${url.search}${url.hash}`));
				return;
			}
		} catch {
			// Fall through to opening externally.
		}
		await openExternal(target.url);
	}
}

/**
 * Open a link found in message text: internal targets (bare cordn1 ref, app-host
 * URL, or app-relative path) go through goto() in-app; everything else opens in a
 * new tab / system browser. Centralizes the decision so a cordn1 string or a
 * cordn.net/… link pasted into a chat navigates internally instead of spawning
 * a blank tab.
 */
export async function openMessageLink(href: string): Promise<void> {
	const target = parseShareTarget(href);
	if (target) {
		await gotoShareTarget(target);
		return;
	}
	await openExternal(href);
}
