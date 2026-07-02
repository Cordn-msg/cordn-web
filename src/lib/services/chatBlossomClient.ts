import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from 'applesauce-core/helpers';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools';

/**
 * Minimal Blossom client (BUD-01/02/11) following the same request shape as
 * the `blossom-client-sdk` reference: `PUT /upload` with an `X-SHA-256` header
 * and a signed kind-24242 token in `Authorization: Nostr <base64(event)>`, then
 * `GET /<sha256>` to fetch.
 *
 * The auth header is plain `btoa()` standard base64 — NOT base64url — because
 * that is what the SDK's `encodeAuthorizationHeader` and BUD-11's own worked
 * example ship, and what every server accepts. blossom.primal.net actively
 * rejects the base64url alphabet as "invalid base64 for auth event", so the
 * URL-safe variant is wrong despite BUD-11's prose saying "without padding".
 *
 * No SDK dependency: blossom is HTTP + one signed nostr event. The signer is a
 * structural type so the client is testable without an applesauce account, and
 * it stays out of the worker boundary (signing is main-thread; only the later
 * media *decrypt* runs off-thread). Uploads sign with a throwaway key via
 * `ephemeralBlossomSigner()`, NOT the active identity — the same unlinkable
 * pattern as anonymous zaps in donations/nip57.
 */

/** BUD-11: short-lived auth keeps the replay window small. */
const AUTH_TTL_SECONDS = 5 * 60;

/** Structural signer interface — anything with a `signEvent`. */
export interface BlossomSigner {
	signEvent(template: EventTemplate): Promise<NostrEvent>;
}

/**
 * A throwaway keypair that signs Blossom auth tokens, so uploads are NOT tied
 * to the active Nostr identity. Fresh secret per `signEvent`: auth tokens are
 * scoped and short-lived (BUD-11), the blobs are content-addressed ciphertext
 * we never list/delete, and per-upload unlinkability is the goal — same shape
 * as `signZapRequestAnonymously` in donations/nip57.
 */
export function ephemeralBlossomSigner(): BlossomSigner {
	return {
		async signEvent(template) {
			return finalizeEvent(template, generateSecretKey());
		}
	};
}

export type BlossomAuthAction = 'upload' | 'get' | 'list' | 'delete';

/**
 * `Authorization: Nostr <base64(JSON event)>` (BUD-11 §HTTP Authorization
 * Header). Plain `btoa()` standard base64 — matching the `blossom-client-sdk`
 * reference and BUD-11's worked example — NOT base64url:
 * blossom.primal.net's decoder rejects the URL-safe alphabet as "invalid base64
 * for auth event", while it (and every other store) accepts standard base64.
 */
export function blossomAuthHeader(event: NostrEvent): string {
	return `Nostr ${btoa(JSON.stringify(event))}`;
}

/**
 * Build + sign a kind-24242 authorization token (BUD-11). Tokens are scoped to
 * the target `server` hostname and — when `sha256Hex` is given — to that blob
 * hash (`x` tag), so a leaked upload token can't be replayed to delete blobs or
 * hit other servers. BUD-11 §Security warns unscoped delete tokens are the
 * dangerous case; scoping upload/get is free hygiene.
 */
export async function buildBlossomAuth(params: {
	signer: BlossomSigner;
	action: BlossomAuthAction;
	serverUrl: string;
	/** Lowercase hex sha256 of the blob; required for upload/delete, optional for get. */
	sha256Hex?: string;
	content?: string;
}): Promise<NostrEvent> {
	const now = Math.floor(Date.now() / 1000);
	const host = new URL(params.serverUrl).hostname;
	const tags: string[][] = [
		['t', params.action],
		['expiration', String(now + AUTH_TTL_SECONDS)],
		['server', host]
	];
	if (params.sha256Hex) tags.push(['x', params.sha256Hex]);
	return params.signer.signEvent({
		kind: 24242,
		content: params.content ?? 'Upload media',
		created_at: now,
		tags
	});
}

/**
 * Upload failure carrying the HTTP status, or `undefined` when the request got
 * no response (network/CORS block).
 */
export class BlossomUploadError extends Error {
	constructor(
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'BlossomUploadError';
	}
}

export interface UploadedBlob {
	/** GET URL of the stored blob (descriptor `url`). Carried in the `imeta`. */
	readonly url: string;
	/** Lowercase hex sha256(blob) — the content address + `X-SHA-256`. */
	readonly sha256: string;
	readonly size: number;
}

/**
 * Upload an encrypted blob via `PUT /upload` (BUD-02), mirroring the
 * `blossom-client-sdk` request: `X-SHA-256` + `Authorization` headers and the
 * raw bytes as the body. `Content-Type` is set explicitly to
 * `application/octet-stream` — the truthful type for AEAD ciphertext (opaque
 * bytes); the real MIME stays sealed in the `imeta` `m` field. Every server in
 * `BLOSSOM_SERVERS` was verified to accept octet-stream; media-optimizer stores
 * that reject it or sniff/re-encode uploads are kept out of the list.
 *
 * Failures throw `BlossomUploadError` carrying the HTTP `status` (or
 * `undefined` for a network/CORS block).
 */
export async function uploadBlob(params: {
	serverUrl: string;
	blob: Uint8Array;
	signer: BlossomSigner;
}): Promise<UploadedBlob> {
	const server = params.serverUrl.replace(/\/+$/, '');
	const sha256Hex = bytesToHex(sha256(params.blob));
	const event = await buildBlossomAuth({
		signer: params.signer,
		action: 'upload',
		serverUrl: server,
		sha256Hex,
		content: 'Upload encrypted media'
	});

	let res: Response;
	try {
		res = await fetch(`${server}/upload`, {
			method: 'PUT',
			headers: {
				'X-SHA-256': sha256Hex,
				'Content-Type': 'application/octet-stream',
				Authorization: blossomAuthHeader(event)
			},
			// params.blob is ArrayBuffer-backed (fresh from encryptMedia); cast to
			// BufferSource so TS 6's Uint8Array<ArrayBufferLike> widening is accepted
			// by BodyInit. Local cast, not an MLS-library import.
			body: params.blob as BufferSource
		});
	} catch {
		// fetch threw before any response — network failure or a CORS preflight
		// rejection. Either way the server is unreachable from the browser; surface
		// it with no status so the caller can fall back to another server.
		throw new BlossomUploadError(`Could not reach ${server} (network or CORS blocked)`);
	}

	if (!res.ok) {
		let reason = res.statusText;
		try {
			const text = await res.text();
			if (text) reason = text.slice(0, 200);
		} catch {
			/* body already consumed or not text; keep statusText */
		}
		throw new BlossomUploadError(
			`Blossom upload to ${server} failed (${res.status}): ${reason}`,
			res.status
		);
	}
	const descriptor = (await res.json()) as { url?: string; sha256?: string; size?: number };
	if (!descriptor.url || descriptor.sha256 !== sha256Hex) {
		throw new Error('Blossom upload returned an unexpected descriptor');
	}
	return {
		url: descriptor.url,
		sha256: descriptor.sha256,
		size: descriptor.size ?? params.blob.length
	};
}

/**
 * GET an uploaded blob and confirm the served bytes hash to the expected
 * sha256. Catches media-optimizer servers (e.g. nostr.build, bostr.online) that
 * accept a `PUT /upload` and return 2xx but silently re-encode: the bytes they
 * serve back differ from what we stored, so AEAD decryption would fail for
 * every recipient with no obvious cause. Used in the upload fallback loop so a
 * transforming server is treated as a failure and the next server is tried.
 */
export async function verifyBlobRoundtrip(url: string, expectedSha256Hex: string): Promise<void> {
	const bytes = await fetchBlob(url);
	if (bytesToHex(sha256(bytes)) !== expectedSha256Hex.toLowerCase()) {
		throw new BlossomUploadError(
			'server served bytes that do not match the uploaded blob (round-trip sha256 mismatch)'
		);
	}
}

/**
 * Fetch a blob by its URL (BUD-01 GET). Anonymous: most servers permit it.
 * ponytail: some servers answer 401 and require a `get` auth token (BUD-11);
 * add a signed-get retry path only when a server we use actually demands it.
 */
export async function fetchBlob(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Blossom fetch failed: ${res.status} ${res.statusText}`);
	}
	return new Uint8Array(await res.arrayBuffer());
}
