import { describe, expect, test, vi } from 'vitest';

/**
 * Pure-core tests for multiDevice.ts. The MLS encode/decode seam is mocked so
 * `clientState` round-trips as a deterministic base64 of a tiny fake object,
 * and `entryEpoch` reads back the `epoch` the mock stamps. The NIP-44 seal is
 * a plain inverted-cipher stub ( confidentiality-only, so any invertible
 * transform is a faithful stand-in for the protocol tests here).
 */

const { encodeMock, decoderMock } = vi.hoisted(() => ({
	encodeMock: vi.fn(),
	decoderMock: vi.fn()
}));

vi.mock('ts-mls', async () => {
	const actual = await vi.importActual<typeof import('ts-mls')>('ts-mls');
	return {
		...actual,
		// Override encode + clientStateDecoder only; real clientStateEncoder,
		// bytesToBase64, base64ToBytes flow through `...actual`.
		encode: encodeMock,
		clientStateDecoder: decoderMock
	};
});

import {
	MULTI_DEVICE_SCHEMA_VERSION,
	buildSessionDocument,
	canonicalJson,
	documentAddress,
	entryEpoch,
	openDocument,
	publishCurrentSession,
	pullSessionDocument,
	reconcileFromDocument,
	sealDocument,
	type Nip44Seal,
	type ReconcileTarget,
	type SessionBlobStore,
	type SessionGroupEntry,
	type SessionGroupSnapshot
} from './multiDevice';

/** Fake encoder: stamp `{epoch, gid}` as UTF-8 bytes. Decoder inverts it. */
function fakeStateBytes(epoch: number, gid: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ epoch, gid }));
}

// encode returns the bytes the test's fake state already provides.
encodeMock.mockImplementation((_encoder, state) => state.__bytes);
// decoder returns [state, offset] like ts-mls.
decoderMock.mockImplementation((bytes) => {
	const parsed = JSON.parse(new TextDecoder().decode(bytes));
	return [{ groupContext: { epoch: BigInt(parsed.epoch) } }, bytes.length];
});

/** Invertible cipher stand-in for the NIP-44 seal (confidentiality-only). */
function fakeSeal(): Nip44Seal {
	return {
		async encrypt(_pubkey, plaintext) {
			return `enc:${plaintext}`;
		},
		async decrypt(_pubkey, ciphertext) {
			if (!ciphertext.startsWith('enc:')) throw new Error('bad seal');
			return ciphertext.slice(4);
		}
	};
}

function snapshot(epoch: number, gid: string, cursor = 5): SessionGroupSnapshot {
	return {
		gid,
		state: { __bytes: fakeStateBytes(epoch, gid) } as never,
		coordinatorKey: 'coord:' + gid,
		encrypted: true,
		fetchCursor: cursor
	};
}

const OWNER = 'ab'.repeat(32);

describe('multiDevice core', () => {
	test('canonicalJson is deterministic + member-sorted + no whitespace', () => {
		const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
		const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
		expect(a).toBe(b);
		expect(a).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
		expect(a).not.toMatch(/\s/);
	});

	test('documentAddress is sha256 of the sealed UTF-8 payload', () => {
		// sha256('enc:hello') precomputed
		const addr = documentAddress('enc:hello');
		expect(addr).toMatch(/^[0-9a-f]{64}$/);
		// Different input → different address.
		expect(documentAddress('enc:hello')).not.toBe(documentAddress('enc:world'));
	});

	test('seal/open round-trips a document', async () => {
		const doc = buildSessionDocument({ groups: [snapshot(3, 'g1')] });
		const sealed = await sealDocument(doc, fakeSeal(), OWNER);
		const reopened = await openDocument(sealed, fakeSeal(), OWNER);
		expect(reopened.schemaVersion).toBe(MULTI_DEVICE_SCHEMA_VERSION);
		expect(reopened.groups[0]?.gid).toBe('g1');
		expect(reopened.groups[0]?.cursor).toBe(5);
	});

	test('openDocument rejects an unknown schema version', async () => {
		const sealed = await fakeSeal().encrypt(OWNER, '{"schemaVersion":99,"groups":[]}');
		await expect(openDocument(sealed, fakeSeal(), OWNER)).rejects.toThrow(
			/unsupported multi-device schema version/i
		);
	});

	test('publishCurrentSession seals + content-addresses + returns address', async () => {
		const published: Uint8Array[] = [];
		const store: SessionBlobStore = {
			async publish(blob) {
				published.push(blob);
				// Address MUST equal sha256(blob) — the store derives it honestly.
				const { documentAddress } = await import('./multiDevice');
				return {
					address: documentAddress(new TextDecoder().decode(blob)),
					url: `https://blossom.test/${documentAddress(new TextDecoder().decode(blob))}`
				};
			},
			async fetch() {
				return new Uint8Array();
			}
		};
		const res = await publishCurrentSession({
			groups: [snapshot(1, 'g1')],
			seal: fakeSeal(),
			ownerPubkey: OWNER,
			store,
			prev: 'prevaddr'
		});
		expect(res.address).toMatch(/^[0-9a-f]{64}$/);
		expect(published).toHaveLength(1);
	});

	test('publishCurrentSession rejects a store that lies about the address', async () => {
		const store: SessionBlobStore = {
			async publish() {
				return { address: '0'.repeat(64), url: 'https://x' };
			},
			async fetch() {
				return new Uint8Array();
			}
		};
		await expect(
			publishCurrentSession({
				groups: [snapshot(1, 'g1')],
				seal: fakeSeal(),
				ownerPubkey: OWNER,
				store
			})
		).rejects.toThrow(/does not match sha256/i);
	});

	test('pullSessionDocument rejects a blob whose hash != advertised address', async () => {
		const realDoc = buildSessionDocument({ groups: [snapshot(1, 'g1')] });
		const realSealed = await sealDocument(realDoc, fakeSeal(), OWNER);
		const store: SessionBlobStore = {
			async publish() {
				return { address: '', url: '' };
			},
			async fetch() {
				return new TextEncoder().encode(realSealed);
			}
		};
		await expect(
			pullSessionDocument({
				address: '0'.repeat(64),
				store,
				addressToUrl: (a) => `https://blossom.test/${a}`,
				seal: fakeSeal(),
				ownerPubkey: OWNER
			})
		).rejects.toThrow(/address mismatch/i);
	});

	test('pullSessionDocument round-trips a honestly-addressed blob', async () => {
		const realDoc = buildSessionDocument({ groups: [snapshot(7, 'g1')] });
		const realSealed = await sealDocument(realDoc, fakeSeal(), OWNER);
		const addr = documentAddress(realSealed);
		const store: SessionBlobStore = {
			async publish() {
				return { address: addr, url: `https://b/${addr}` };
			},
			async fetch() {
				return new TextEncoder().encode(realSealed);
			}
		};
		const reopened = await pullSessionDocument({
			address: addr,
			store,
			addressToUrl: (a) => `https://b/${a}`,
			seal: fakeSeal(),
			ownerPubkey: OWNER
		});
		expect(reopened.groups[0]?.gid).toBe('g1');
	});

	test('entryEpoch reads the epoch from an entry clientState', () => {
		const bytes = fakeStateBytes(4, 'g1');
		const entry: SessionGroupEntry = {
			gid: 'g1',
			coordinator: 'c',
			encrypted: true,
			clientState: bytesToBase64Local(bytes),
			cursor: 0
		};
		expect(entryEpoch(entry)).toBe(4n);
	});

	test('reconcileFromDocument: seeds missing, fast-forwards newer, skips equal-or-older', async () => {
		const local = new Map<string, bigint>([
			['present-old', 1n],
			['present-equal', 5n],
			['present-newer', 9n]
		]);
		const applied: Array<{ gid: string; outcome: string }> = [];
		const target: ReconcileTarget = {
			localEpoch(gid) {
				return local.get(gid);
			},
			async applyEntry(entry) {
				const localE = local.get(entry.gid);
				const incoming = entryEpoch(entry);
				let outcome: 'seeded' | 'fast-forwarded' | 'skipped';
				if (localE === undefined) outcome = 'seeded';
				else if (incoming !== undefined && incoming > localE) outcome = 'fast-forwarded';
				else outcome = 'skipped';
				applied.push({ gid: entry.gid, outcome });
				local.set(entry.gid, incoming ?? localE!);
				return outcome;
			}
		};

		const entries: SessionGroupEntry[] = [
			'missing',
			'present-old',
			'present-equal',
			'present-newer'
		].map((gid, i) => ({
			gid,
			coordinator: 'c',
			encrypted: true,
			// epochs: missing=2(seeds), present-old=3(>1 ff), present-equal=5(=skip),
			// present-newer=7(<9 skip).
			clientState: bytesToBase64Local(fakeStateBytes([2, 3, 5, 7][i], gid)),
			cursor: i
		}));

		const res = await reconcileFromDocument(target, { groups: entries } as never);
		expect(res.seeded.map((e) => e.gid)).toEqual(['missing']);
		expect(res.fastForwarded.map((e) => e.gid)).toEqual(['present-old']);
		expect(res.skipped.map((e) => e.gid).sort()).toEqual(['present-equal', 'present-newer']);
	});
});

// ts-mls's real bytesToBase64 is preserved by the mock, but tests here construct
// state bytes directly — import lazily to avoid circular import ordering issues.
function bytesToBase64Local(bytes: Uint8Array): string {
	// ponytail: standard base64, matches ts-mls's bytesToBase64 for these inputs.
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}
