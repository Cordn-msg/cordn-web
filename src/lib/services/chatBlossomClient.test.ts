import { afterEach, describe, expect, test } from 'vitest';
import { bytesToHex } from 'applesauce-core/helpers';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEvent } from 'nostr-tools/pure';
import type { EventTemplate, NostrEvent } from 'nostr-tools';

import {
	blossomAuthHeader,
	buildBlossomAuth,
	BlossomUploadError,
	deleteBlob,
	ephemeralBlossomSigner,
	fetchBlob,
	uploadBlob,
	verifyBlobRoundtrip,
	type BlossomSigner
} from '$lib/services/chatBlossomClient';

/**
 * BUD-11/02 self-check with a stub signer and a mocked global fetch. Asserts
 * the auth-event shape (kind 24242, scoped `t`/`expiration`/`server`/`x` tags),
 * the `Nostr <base64>` header encoding, and the upload/fetch call shapes —
 * without network or a real account.
 */
const SERVER = 'https://blossom.primal.net/';

/** Signs by finalizing into a fixed fake sig/id; sufficient to assert structure. */
function stubSigner(pubkey = '00'.repeat(32)): BlossomSigner & { last: EventTemplate | null } {
	const signer = {
		last: null as EventTemplate | null,
		async signEvent(template: EventTemplate): Promise<NostrEvent> {
			this.last = template;
			return { ...template, pubkey, id: '0'.repeat(64), sig: '0'.repeat(128) } as NostrEvent;
		}
	};
	return signer as BlossomSigner & { last: EventTemplate | null };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('BUD-11 auth token', () => {
	test('builds a scoped kind-24242 token with t/expiration/server/x', async () => {
		const signer = stubSigner();
		const sha = 'a'.repeat(64);
		const event = await buildBlossomAuth({
			signer,
			action: 'upload',
			serverUrl: SERVER,
			sha256Hex: sha,
			content: 'Upload encrypted media'
		});

		expect(event.kind).toBe(24242);
		expect(event.content).toBe('Upload encrypted media');
		const tag = (k: string) => event.tags.find((t) => t[0] === k);
		expect(tag('t')?.[1]).toBe('upload');
		expect(tag('server')?.[1]).toBe('blossom.primal.net');
		expect(tag('x')?.[1]).toBe(sha);
		expect(Number(tag('expiration')?.[1])).toBeGreaterThan(Math.floor(Date.now() / 1000));
		// Template handed to the signer carried the same tags.
		expect(signer.last?.kind).toBe(24242);
		expect(signer.last?.tags.some((t) => t[0] === 'server' && t[1] === 'blossom.primal.net')).toBe(
			true
		);
	});

	test('omits the x tag when no sha256 is given', async () => {
		const event = await buildBlossomAuth({
			signer: stubSigner(),
			action: 'get',
			serverUrl: 'https://nostr.download/'
		});
		expect(event.tags.some((t) => t[0] === 'x')).toBe(false);
		expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe('get');
	});

	test('scopes the server tag to the hostname only (BUD-11)', async () => {
		const event = await buildBlossomAuth({
			signer: stubSigner(),
			action: 'delete',
			serverUrl: 'https://blossom.band/some/path',
			sha256Hex: 'b'.repeat(64)
		});
		expect(event.tags.find((t) => t[0] === 'server')?.[1]).toBe('blossom.band');
	});
});

describe('auth header', () => {
	test('is Nostr <base64> of the JSON event — standard btoa, not base64url', () => {
		const event = {
			kind: 24242,
			pubkey: '00'.repeat(32),
			id: '0'.repeat(64),
			sig: '0'.repeat(128),
			content: '',
			created_at: 1,
			tags: [['t', 'upload']]
		} as NostrEvent;
		const json = JSON.stringify(event);
		const header = blossomAuthHeader(event);

		// `Nostr ` scheme + plain standard base64 — this is what the SDK's
		// encodeAuthorizationHeader and BUD-11's worked example ship, and what
		// blossom.primal.net's decoder accepts (it rejects the base64url alphabet).
		expect(header).toBe(`Nostr ${btoa(json)}`);
		// Round-trips back to the same event JSON.
		expect(JSON.parse(atob(header.slice('Nostr '.length)))).toEqual(event);
	});
});

describe('ephemeralBlossomSigner', () => {
	test('signs with a fresh, verifiable key per call (unlinkable)', async () => {
		const signer = ephemeralBlossomSigner();
		// Fresh template per call: finalizeEvent mutates+returns its input, so a
		// shared object would alias a===b and hide a key-reuse regression.
		const template = (): EventTemplate => ({
			kind: 24242,
			content: '',
			created_at: 1,
			tags: [['t', 'upload']]
		});

		// ponytail: one check for the security intent — two calls must NOT share an
		// identity (or uploads become correlatable), and the sig must verify.
		const a = await signer.signEvent(template());
		const b = await ephemeralBlossomSigner().signEvent(template());
		expect(verifyEvent(a)).toBe(true);
		expect(verifyEvent(b)).toBe(true);
		expect(a.pubkey).not.toBe(b.pubkey);
		expect(a.sig).not.toBe(b.sig);
	});
});

describe('uploadBlob (BUD-02)', () => {
	test('PUTs the raw blob with X-SHA-256 + Nostr auth and returns the descriptor url', async () => {
		const blob = new Uint8Array([1, 2, 3, 4, 5]);
		const expectedSha = bytesToHex(sha256(blob));

		let captured: {
			url: string;
			method: string;
			headers: Record<string, string>;
			body: Uint8Array;
		} | null = null;

		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			captured = {
				url: String(input),
				method: init?.method ?? 'GET',
				headers: Object.fromEntries(new Headers(init?.headers)) as Record<string, string>,
				body: new Uint8Array((init?.body as Uint8Array) ?? [])
			};
			return new Response(
				JSON.stringify({
					url: `${SERVER}${expectedSha}.bin`,
					sha256: expectedSha,
					size: blob.length
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			);
		}) as typeof fetch;

		const result = await uploadBlob({ serverUrl: SERVER, blob, signer: stubSigner() });

		expect(result.url).toBe(`${SERVER}${expectedSha}.bin`);
		expect(result.sha256).toBe(expectedSha);
		expect(captured!.url).toBe(`${SERVER}upload`);
		expect(captured!.method).toBe('PUT');
		// X-SHA-256 carries the blob hash (BUD-02). Content-Type is the truthful
		// application/octet-stream for AEAD ciphertext; the real MIME stays sealed
		// in the imeta.
		expect(captured!.headers['x-sha-256']).toBe(expectedSha);
		expect(captured!.headers['content-type']).toBe('application/octet-stream');
		expect(captured!.headers['authorization'].startsWith('Nostr ')).toBe(true);
		expect(Array.from(captured!.body)).toEqual([1, 2, 3, 4, 5]);
	});

	test('throws when the descriptor sha256 does not match the uploaded body', async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ url: 'https://x/abc', sha256: '0'.repeat(64) }), {
				status: 201
			})) as typeof fetch;
		await expect(
			uploadBlob({ serverUrl: SERVER, blob: new Uint8Array([1, 2, 3]), signer: stubSigner() })
		).rejects.toThrow('unexpected descriptor');
	});

	test('throws BlossomUploadError carrying the HTTP status on a non-ok response', async () => {
		globalThis.fetch = (async () => new Response('too big', { status: 413 })) as typeof fetch;
		try {
			await uploadBlob({ serverUrl: SERVER, blob: new Uint8Array([1]), signer: stubSigner() });
			expect.fail('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(BlossomUploadError);
			expect((error as BlossomUploadError).status).toBe(413);
			expect((error as BlossomUploadError).message).toContain('413');
		}
	});
});

describe('deleteBlob (BUD-12)', () => {
	test('DELETEs /<sha256> with Nostr auth and returns ok on 204', async () => {
		const sha = bytesToHex(sha256(new Uint8Array([9])));
		let captured: { url: string; method: string; headers: Record<string, string> } | null = null;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			captured = {
				url: String(input),
				method: init?.method ?? 'GET',
				headers: Object.fromEntries(new Headers(init?.headers)) as Record<string, string>
			};
			return new Response(null, { status: 204 });
		}) as typeof fetch;

		const result = await deleteBlob({ serverUrl: SERVER, sha256Hex: sha, signer: stubSigner() });

		expect(result.ok).toBe(true);
		expect(result.status).toBe(204);
		expect(captured!.url).toBe(`${SERVER.replace(/\/+$/, '')}/${sha}`);
		expect(captured!.method).toBe('DELETE');
		expect(captured!.headers['authorization']).toMatch(/^Nostr /);
	});

	test('treats 404 as idempotent success (already gone)', async () => {
		globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
		const result = await deleteBlob({
			serverUrl: SERVER,
			sha256Hex: 'a'.repeat(64),
			signer: stubSigner()
		});
		expect(result.ok).toBe(true);
		expect(result.status).toBe(404);
	});

	test('reports 402/403 as not-ok without throwing (hygiene, never fatal)', async () => {
		globalThis.fetch = (async () => new Response('pay up', { status: 402 })) as typeof fetch;
		const result = await deleteBlob({
			serverUrl: SERVER,
			sha256Hex: 'a'.repeat(64),
			signer: stubSigner()
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe(402);
	});

	test('reports a network/CORS block as status 0 without throwing', async () => {
		globalThis.fetch = (async () => {
			throw new Error('CORS blocked');
		}) as typeof fetch;
		const result = await deleteBlob({
			serverUrl: SERVER,
			sha256Hex: 'a'.repeat(64),
			signer: stubSigner()
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
	});
});

describe('fetchBlob (BUD-01 GET)', () => {
	test('GETs the url anonymously and returns the bytes', async () => {
		let calledUrl: string | null = null;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calledUrl = String(input);
			return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
		}) as typeof fetch;
		const bytes = await fetchBlob(`${SERVER}deadbeef.bin`);
		expect(calledUrl).toBe(`${SERVER}deadbeef.bin`);
		expect(Array.from(bytes)).toEqual([9, 9, 9]);
	});

	test('throws on a non-ok status', async () => {
		globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
		await expect(fetchBlob(`${SERVER}abc`)).rejects.toThrow('404');
	});
});

describe('verifyBlobRoundtrip', () => {
	test('passes when the served bytes hash to the expected sha256', async () => {
		const blob = new Uint8Array([10, 20, 30]);
		globalThis.fetch = (async () => new Response(blob, { status: 200 })) as typeof fetch;
		await expect(
			verifyBlobRoundtrip('https://x/abc', bytesToHex(sha256(blob)))
		).resolves.toBeUndefined();
	});

	test('throws BlossomUploadError when the server serves different bytes (transform trap)', async () => {
		globalThis.fetch = (async () =>
			new Response(new Uint8Array([99, 99, 99]), { status: 200 })) as typeof fetch;
		await expect(verifyBlobRoundtrip('https://x/abc', '0'.repeat(64))).rejects.toThrow(
			'round-trip sha256 mismatch'
		);
	});
});
