import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64, toBufferSource } from 'ts-mls';
import { bytesToHex } from 'applesauce-core/helpers';
import type { EventTemplate, NostrEvent } from 'nostr-tools';

/**
 * Minimal Blossom client (BUD-01/02/11). Encrypted-media blobs are uploaded
 * with `PUT /upload` and fetched with `GET /<sha256>`; uploads carry a signed
 * kind-24242 authorization token in `Authorization: Nostr <base64url(event)>`.
 *
 * No SDK dependency: blossom is HTTP + one signed nostr event, and the signer is
 * the same `account.signer.signEvent` used by donations/extension login. The
 * signer param is a structural type so the client is testable without an
 * applesauce account, and so it stays out of the worker boundary (signing is
 * main-thread; only the later media *decrypt* runs off-thread).
 */

const encoder = new TextEncoder();

/** BUD-11: short-lived auth keeps the replay window small. */
const AUTH_TTL_SECONDS = 5 * 60;

/** Structural signer interface — anything with a `signEvent`, e.g. account.signer. */
export interface BlossomSigner {
	signEvent(template: EventTemplate): Promise<NostrEvent>;
}

export type BlossomAuthAction = 'upload' | 'get' | 'list' | 'delete';

/** base64url without padding (JWT-style), per BUD-11 §HTTP Authorization Header. */
function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `Authorization: Nostr <base64url(JSON event)>` (BUD-11 §HTTP Authorization Header). */
export function blossomAuthHeader(event: NostrEvent): string {
	const json = JSON.stringify(event);
	return `Nostr ${bytesToBase64Url(encoder.encode(json))}`;
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

export interface UploadedBlob {
	/** GET URL of the stored blob (descriptor `url`). Carried in the `imeta`. */
	readonly url: string;
	/** Lowercase hex sha256(blob) — the content address + `X-SHA-256`. */
	readonly sha256: string;
	readonly size: number;
}

/**
 * Upload an encrypted blob via `PUT /upload` (BUD-02).
 *
 * `Content-Type` is forced to `application/octet-stream`: the body is AEAD
 * ciphertext and the real MIME must NOT leak to the store (it travels only
 * inside the sealed `imeta` `m` field). BUD-02 forbids the server from
 * modifying `/upload` bodies, so there is no transcoding risk on this
 * endpoint — and we never trust the descriptor's declared `type`, only the
 * sealed `m`.
 *
 * No `X-SHA-256` header: it is optional (BUD-02) and, for us, useless — we
 * always send a hash-correct body, so the server's `409 Conflict` path never
 * fires. Dropping it also shrinks the CORS preflight's required
 * `Access-Control-Allow-Headers`, which is what unblocks servers whose CORS
 * config allows `Authorization`/`Content-Type` but not arbitrary `X-*` headers.
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
				'Content-Type': 'application/octet-stream',
				Authorization: blossomAuthHeader(event)
			},
			// ponytail: toBufferSource (ts-mls) is a no-op for ArrayBuffer-backed bytes;
			// works around TS 6 widening Uint8Array to Uint8Array<ArrayBufferLike>, which
			// BodyInit rejects. Same pattern as chatBackupWorker.ts.
			body: toBufferSource(params.blob)
		});
	} catch {
		// fetch threw before any response — network failure or a CORS preflight
		// rejection. Either way the server is unreachable from the browser; surface
		// it so the caller can fall back to another server.
		throw new Error(`Could not reach ${server} (network or CORS blocked)`);
	}

	if (!res.ok) {
		let reason = res.statusText;
		try {
			const text = await res.text();
			if (text) reason = text.slice(0, 200);
		} catch {
			/* body already consumed or not text; keep statusText */
		}
		throw new Error(`Blossom upload to ${server} failed (${res.status}): ${reason}`);
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
