import { describe, expect, test, vi } from 'vitest';

/**
 * Pure-core tests for multiDevice.ts. The MLS encode/decode seam is mocked so
 * `clientState` round-trips as a deterministic base64 of a tiny fake object,
 * and `groupEpoch` reads back the `epoch` the mock stamps. The NIP-44 seal is
 * a plain inverted-cipher stub (confidentiality-only, so any invertible
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
	composeTombstoneUnion,
	documentAddress,
	groupEpoch,
	openDocument,
	publishGroupDocument,
	publishMetaDocument,
	pullDocument,
	reconcileMetaDocument,
	sealDocument,
	walkGroupChain,
	buildInventory,
	partitionGapByEpoch,
	planCarryForward,
	type BlobStore,
	type GroupDocument,
	type GroupSnapshot,
	type LastResortKeyPackageEntry,
	type MetaDocument,
	type Nip44Seal,
	type ReconcileTarget,
	type Tombstone,
	type TipGroupPointer,
	type TipPointer
} from './multiDevice';
import { nip44 } from 'applesauce-core/helpers/encryption';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

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

const OWNER = 'ab'.repeat(32);

function snapshot(epoch: number, gid: string, cursor = 5): GroupSnapshot {
	return {
		gid,
		state: { __bytes: fakeStateBytes(epoch, gid) } as never,
		coordinatorKey: 'coord:' + gid,
		fetchCursor: cursor
	};
}

function groupDoc(epoch: number, gid: string, cursor = 5, prev?: string): GroupDocument {
	return {
		schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
		type: 'group',
		gid,
		coordinator: 'coord:' + gid,
		issuedAt: 0,
		prev,
		clientState: bytesToBase64Local(fakeStateBytes(epoch, gid)),
		cursor
	};
}

function metaDoc(opts: {
	removed?: Tombstone[];
	lastResortKeyPackage?: LastResortKeyPackageEntry;
}): MetaDocument {
	return { schemaVersion: MULTI_DEVICE_SCHEMA_VERSION, type: 'meta', issuedAt: 0, ...opts };
}

function tombstone(gid: string, epoch: number): Tombstone {
	return { gid, epoch };
}

/** An honest store: derives the address from the bytes it receives. */
function honestStore(blobs?: Map<string, Uint8Array>): BlobStore {
	const store = blobs ?? new Map<string, Uint8Array>();
	return {
		async publish(blob) {
			const sealed = new TextDecoder().decode(blob);
			const address = documentAddress(sealed);
			store.set(address, blob);
			return { address, url: `https://blossom.test/${address}` };
		},
		async fetch(url) {
			const address = url.split('/').pop()!;
			const blob = store.get(address);
			if (!blob) throw new Error('not found: ' + address);
			return blob;
		}
	};
}

describe('multiDevice core', () => {
	test('documentAddress is sha256 of the sealed UTF-8 payload', () => {
		const addr = documentAddress('enc:hello');
		expect(addr).toMatch(/^[0-9a-f]{64}$/);
		expect(documentAddress('enc:hello')).not.toBe(documentAddress('enc:world'));
	});

	test('seal/open round-trips a group document', async () => {
		const sealed = await sealDocument(groupDoc(3, 'g1'), fakeSeal(), OWNER);
		const reopened = await openDocument(sealed, fakeSeal(), OWNER);
		expect(reopened.schemaVersion).toBe(MULTI_DEVICE_SCHEMA_VERSION);
		expect(reopened.type).toBe('group');
		if (reopened.type === 'group') {
			expect(reopened.gid).toBe('g1');
			expect(reopened.cursor).toBe(5);
		}
	});

	test('openDocument rejects an unknown schema version', async () => {
		const sealed = await fakeSeal().encrypt(OWNER, '{"schemaVersion":99,"type":"group"}');
		await expect(openDocument(sealed, fakeSeal(), OWNER)).rejects.toThrow(
			/unsupported multi-device schema version/i
		);
	});

	test('openDocument rejects an unknown document type', async () => {
		const sealed = await fakeSeal().encrypt(
			OWNER,
			`{"schemaVersion":${MULTI_DEVICE_SCHEMA_VERSION},"type":"bogus"}`
		);
		await expect(openDocument(sealed, fakeSeal(), OWNER)).rejects.toThrow(/unknown document type/i);
	});

	test('publishGroupDocument seals + content-addresses + threads prev', async () => {
		const store = honestStore();
		const res = await publishGroupDocument({
			group: snapshot(1, 'g1'),
			seal: fakeSeal(),
			dekPubkey: OWNER,
			store,
			prev: 'prevaddr'
		});
		expect(res.address).toMatch(/^[0-9a-f]{64}$/);
		// Round-trips through the honest store and carries prev.
		const pulled = await pullDocument({
			address: res.address,
			store,
			addressToUrl: (a) => `https://blossom.test/${a}`,
			seal: fakeSeal(),
			dekPubkey: OWNER
		});
		if (pulled.type === 'group') expect(pulled.prev).toBe('prevaddr');
	});

	test('publishGroupDocument rejects a store that lies about the address', async () => {
		const store: BlobStore = {
			async publish() {
				return { address: '0'.repeat(64), url: 'https://x' };
			},
			async fetch() {
				return new Uint8Array();
			}
		};
		await expect(
			publishGroupDocument({
				group: snapshot(1, 'g1'),
				seal: fakeSeal(),
				dekPubkey: OWNER,
				store
			})
		).rejects.toThrow(/does not match sha256/i);
	});

	test('publishMetaDocument carries removed + lastResortKeyPackage', async () => {
		const store = honestStore();
		const res = await publishMetaDocument({
			seal: fakeSeal(),
			dekPubkey: OWNER,
			store,
			removed: [tombstone('g', 3)],
			lastResortKeyPackage: {
				keyPackage: 'kp',
				privateKeyPackage: 'pkp',
				coordinators: ['c1', 'c2']
			}
		});
		const pulled = await pullDocument({
			address: res.address,
			store,
			addressToUrl: (a) => `https://blossom.test/${a}`,
			seal: fakeSeal(),
			dekPubkey: OWNER
		});
		expect(pulled.type).toBe('meta');
		if (pulled.type === 'meta') {
			expect(pulled.removed).toContainEqual(tombstone('g', 3));
			expect(pulled.lastResortKeyPackage?.keyPackage).toBe('kp');
			// Coordinator association round-trips (spec §11.5 extension) so linked
			// devices restore the kp's per-coordinator publish state.
			expect(pulled.lastResortKeyPackage?.coordinators).toEqual(['c1', 'c2']);
		}
	});

	test('pullDocument rejects a blob whose hash != advertised address', async () => {
		const realSealed = await sealDocument(groupDoc(1, 'g1'), fakeSeal(), OWNER);
		const store: BlobStore = {
			async publish() {
				return { address: '', url: '' };
			},
			async fetch() {
				return new TextEncoder().encode(realSealed);
			}
		};
		await expect(
			pullDocument({
				address: '0'.repeat(64),
				store,
				addressToUrl: (a) => `https://blossom.test/${a}`,
				seal: fakeSeal(),
				dekPubkey: OWNER
			})
		).rejects.toThrow(/address mismatch/i);
	});

	test('groupEpoch reads the epoch from a group document clientState', () => {
		expect(groupEpoch(groupDoc(4, 'g1'))).toBe(4n);
	});
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Build a `ReconcileTarget` over an in-memory `gid → epoch` map. Mirrors the
 * service semantics: seed when absent, fast-forward on strictly-newer, skip
 * otherwise; drop on a tombstone whose epoch ≥ local, ignore stale/unknown.
 * Tracks the last-resort key package in-memory (idempotent by value).
 */
function makeTarget(
	local: Map<string, bigint>,
	opts?: { lastResort?: LastResortKeyPackageEntry }
): ReconcileTarget {
	let heldLastResort = opts?.lastResort;
	return {
		localEpoch(gid) {
			return local.get(gid);
		},
		async applyGroupDocument(doc) {
			const localE = local.get(doc.gid);
			const incoming = groupEpoch(doc);
			let outcome: 'seeded' | 'fast-forwarded' | 'skipped';
			if (localE === undefined) outcome = 'seeded';
			else if (incoming !== undefined && incoming > localE) outcome = 'fast-forwarded';
			else outcome = 'skipped';
			if (outcome !== 'skipped' && incoming !== undefined) local.set(doc.gid, incoming);
			return outcome;
		},
		async applyTombstone(t) {
			const localE = local.get(t.gid);
			if (localE === undefined) return 'ignored';
			if (BigInt(t.epoch) < localE) return 'ignored'; // stale
			local.delete(t.gid);
			return 'dropped';
		},
		async loadLastResortKeyPackage(entry) {
			if (heldLastResort?.keyPackage === entry.keyPackage) return false; // already held
			heldLastResort = entry;
			return true;
		}
	};
}

describe('group reconciliation via ReconcileTarget.applyGroupDocument (spec §8)', () => {
	test('seeds missing, fast-forwards newer, skips equal-or-older', async () => {
		const local = new Map<string, bigint>([
			['present-old', 1n],
			['present-equal', 5n],
			['present-newer', 9n]
		]);
		const target = makeTarget(local);
		// missing=2 → seed; present-old=3>1 → ff; present-equal=5=5 → skip; present-newer=7<9 → skip.
		expect(await target.applyGroupDocument(groupDoc(2, 'missing'))).toBe('seeded');
		expect(await target.applyGroupDocument(groupDoc(3, 'present-old'))).toBe('fast-forwarded');
		expect(await target.applyGroupDocument(groupDoc(5, 'present-equal'))).toBe('skipped');
		expect(await target.applyGroupDocument(groupDoc(7, 'present-newer'))).toBe('skipped');
	});

	test('a strictly-older document is skipped, never downgrading local epoch (§8)', async () => {
		const local = new Map<string, bigint>([['g', 5n]]);
		const outcome = await makeTarget(local).applyGroupDocument(groupDoc(2, 'g'));
		expect(outcome).toBe('skipped');
		expect(local.get('g')).toBe(5n); // unchanged
	});
});

describe('reconcileMetaDocument (spec §8 case 4, §11.5)', () => {
	test('a tombstone drops the local group on reconcile', async () => {
		const local = new Map<string, bigint>([['g', 3n]]);
		const res = await reconcileMetaDocument(
			makeTarget(local),
			metaDoc({ removed: [tombstone('g', 3)] })
		);
		expect(res.dropped).toContainEqual(tombstone('g', 3));
		expect(res.ignored).toHaveLength(0);
		expect(local.has('g')).toBe(false);
	});

	test('a stale tombstone (epoch below local) is ignored (§8 anti-downgrade)', async () => {
		const local = new Map<string, bigint>([['g', 5n]]);
		const res = await reconcileMetaDocument(
			makeTarget(local),
			metaDoc({ removed: [tombstone('g', 3)] })
		);
		expect(res.dropped).toHaveLength(0);
		expect(res.ignored).toContainEqual(tombstone('g', 3));
		expect(local.get('g')).toBe(5n); // retained
	});

	test('a tombstone for an unknown group is ignored', async () => {
		const local = new Map<string, bigint>([]);
		const res = await reconcileMetaDocument(
			makeTarget(local),
			metaDoc({ removed: [tombstone('unknown', 9)] })
		);
		expect(res.dropped).toHaveLength(0);
		expect(res.ignored).toContainEqual(tombstone('unknown', 9));
	});

	test('absence from removed is not removal (spec §8)', async () => {
		const local = new Map<string, bigint>([['g', 3n]]);
		const res = await reconcileMetaDocument(makeTarget(local), metaDoc({ removed: [] }));
		expect(res.dropped).toHaveLength(0);
		expect(local.get('g')).toBe(3n); // retained
	});

	test('loads the last-resort key package, idempotent on re-expose (§11.5)', async () => {
		const local = new Map<string, bigint>();
		const target = makeTarget(local);
		const entry: LastResortKeyPackageEntry = { keyPackage: 'kp1', privateKeyPackage: 'pkp1' };
		const r1 = await reconcileMetaDocument(target, metaDoc({ lastResortKeyPackage: entry }));
		expect(r1.keyPackageLoaded).toBe(true);
		const r2 = await reconcileMetaDocument(target, metaDoc({ lastResortKeyPackage: entry }));
		expect(r2.keyPackageLoaded).toBe(false); // already held
	});
});

describe('composeTombstoneUnion (spec §10.5)', () => {
	test('merges own pending + adopted, dedupes by gid keeping highest epoch', () => {
		const union = composeTombstoneUnion(
			[tombstone('a', 2), tombstone('b', 5)],
			[tombstone('a', 4), tombstone('c', 1)],
			[]
		);
		expect(union.sort((x, y) => (x.gid < y.gid ? -1 : 1))).toEqual([
			tombstone('a', 4),
			tombstone('b', 5),
			tombstone('c', 1)
		]);
	});

	test('XOR: a gid present locally is alive, its tombstone is dropped (§10 resurrection)', () => {
		const union = composeTombstoneUnion([tombstone('alive', 3)], [], ['alive']);
		expect(union).toEqual([]);
	});

	test('empty inputs yield an empty union', () => {
		expect(composeTombstoneUnion([], [], [])).toEqual([]);
	});
});

describe('walkGroupChain (spec §8.5)', () => {
	async function buildChain(epochs: { epoch: number; cursor: number }[], gid = 'g1') {
		const seal = fakeSeal();
		const store = honestStore();
		let prev: string | undefined;
		let tip = '';
		// Oldest-first; each doc links to the prior via `prev` (spec §4.1).
		for (const { epoch, cursor } of epochs) {
			const sealed = await sealDocument(groupDoc(epoch, gid, cursor, prev), seal, OWNER);
			const address = documentAddress(sealed);
			await store.publish(new TextEncoder().encode(sealed));
			prev = address;
			tip = address;
		}
		return { seal, store, tip };
	}

	test('walks prev chain, one gen-0 step per newer epoch, sorted ascending by cursor', async () => {
		const { seal, store, tip } = await buildChain([
			{ epoch: 1, cursor: 10 },
			{ epoch: 2, cursor: 20 },
			{ epoch: 3, cursor: 30 }
		]);
		const chain = await walkGroupChain({
			tipAddress: tip,
			groupId: 'g1',
			localEpoch: 0n,
			store,
			addressToUrl: (a) => `https://x/${a}`,
			seal,
			dekPubkey: OWNER
		});
		expect(chain.map((s) => Number(s.epoch))).toEqual([1, 2, 3]);
		expect(chain.map((s) => s.cursor)).toEqual([10, 20, 30]);
		expect(chain[2]!.address).toBe(tip); // tip is the newest step
	});

	test('stops once it reaches localEpoch (excludes local-and-older)', async () => {
		const { seal, store, tip } = await buildChain([
			{ epoch: 1, cursor: 10 },
			{ epoch: 2, cursor: 20 },
			{ epoch: 3, cursor: 30 }
		]);
		const chain = await walkGroupChain({
			tipAddress: tip,
			groupId: 'g1',
			localEpoch: 2n, // local at epoch 2 → only epoch 3 is strictly newer
			store,
			addressToUrl: (a) => `https://x/${a}`,
			seal,
			dekPubkey: OWNER
		});
		expect(chain.map((s) => Number(s.epoch))).toEqual([3]);
	});

	test('keeps the oldest (smallest cursor = gen-0) doc per epoch', async () => {
		// epoch 2 published twice: cursor 20 (gen-0) then cursor 25 (advanced
		// ratchet). A newer same-epoch doc cannot decrypt that epoch's earlier
		// messages (MLS forward secrecy), so the walk keeps cursor 20.
		const seal = fakeSeal();
		const store = honestStore();
		const put = async (doc: GroupDocument) => {
			const sealed = await sealDocument(doc, seal, OWNER);
			await store.publish(new TextEncoder().encode(sealed));
			return documentAddress(sealed);
		};
		const a1 = await put(groupDoc(1, 'g1', 10));
		const a2a = await put(groupDoc(2, 'g1', 20, a1));
		const a2b = await put(groupDoc(2, 'g1', 25, a2a));
		const tip = await put(groupDoc(3, 'g1', 30, a2b));

		const chain = await walkGroupChain({
			tipAddress: tip,
			groupId: 'g1',
			localEpoch: 0n,
			store,
			addressToUrl: (a) => `https://x/${a}`,
			seal,
			dekPubkey: OWNER
		});
		const epoch2 = chain.filter((s) => Number(s.epoch) === 2);
		expect(epoch2).toHaveLength(1);
		expect(epoch2[0]!.cursor).toBe(20);
	});

	test('stops at a meta doc or a different group (per-gid chain)', async () => {
		const { seal, store, tip } = await buildChain([{ epoch: 1, cursor: 10 }], 'g1');
		const chain = await walkGroupChain({
			tipAddress: tip,
			groupId: 'g-other', // different gid → the tip doc is not this group's
			localEpoch: 0n,
			store,
			addressToUrl: (a) => `https://x/${a}`,
			seal,
			dekPubkey: OWNER
		});
		expect(chain).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Chained catch-up gap partitioning (spec §8.5)
// ---------------------------------------------------------------------------

/** The catch-up replay pairs `states[i]` with `ranges[i]`: range i covers
 * `(boundaries[i], boundaries[i+1]]` and decrypts with that epoch's gen-0
 * ClientState. `states` has one fewer element than `boundaries`. */
function gapMsg(cursor: number): { cursor: number; opaqueMessageBase64: string } {
	return { cursor, opaqueMessageBase64: `m${cursor}` };
}

describe('partitionGapByEpoch (spec §8.5 replay boundaries)', () => {
	test('partitions the gap by chain cursor, every message in exactly one range', () => {
		// decryptFrontier=100; chain epochs at cursors 150, 200 → 3 states (local + 2).
		const boundaries = [100, 150, 200, Number.POSITIVE_INFINITY];
		const gap = [gapMsg(110), gapMsg(150), gapMsg(175), gapMsg(200), gapMsg(250)];
		const ranges = partitionGapByEpoch(gap, boundaries);
		expect(ranges).toHaveLength(3); // boundaries.length - 1 === states.length
		expect(ranges[0]!.messages.map((m) => m.cursor)).toEqual([110, 150]); // (100,150]
		expect(ranges[1]!.messages.map((m) => m.cursor)).toEqual([175, 200]); // (150,200]
		expect(ranges[2]!.messages.map((m) => m.cursor)).toEqual([250]); // (200,∞]
		// No message is dropped or duplicated across ranges.
		const all = ranges.flatMap((r) => r.messages.map((m) => m.cursor));
		expect(all).toEqual([110, 150, 175, 200, 250]);
	});

	test('half-open (lo, hi]: cursor == lo excluded, cursor == hi included', () => {
		// cursor 100 == decryptFrontier: already processed, must NOT replay.
		// cursor 150 == first chain boundary: belongs to the epoch that just ended,
		// so it lands in range 0 (the local epoch's tail), not range 1.
		const boundaries = [100, 150, Number.POSITIVE_INFINITY];
		const ranges = partitionGapByEpoch([gapMsg(100), gapMsg(150)], boundaries);
		expect(ranges[0]!.messages.map((m) => m.cursor)).toEqual([150]);
		expect(ranges[1]!.messages.map((m) => m.cursor)).toEqual([]);
	});

	test("the +Infinity sentinel captures the tip epoch's tail", () => {
		const boundaries = [0, Number.POSITIVE_INFINITY];
		const ranges = partitionGapByEpoch([gapMsg(1), gapMsg(999_999)], boundaries);
		expect(ranges).toHaveLength(1);
		expect(ranges[0]!.hi).toBe(Number.POSITIVE_INFINITY);
		expect(ranges[0]!.messages.map((m) => m.cursor)).toEqual([1, 999_999]);
	});

	test('returns a (possibly empty) range per epoch so the caller can index states[]', () => {
		// An epoch with no messages in its window still gets a range — the caller
		// skips empty ranges but relies on `ranges[i]` pairing with `states[i]`.
		const boundaries = [0, 10, 20, Number.POSITIVE_INFINITY];
		const ranges = partitionGapByEpoch([gapMsg(25)], boundaries);
		expect(ranges.map((r) => r.messages.length)).toEqual([0, 0, 1]);
	});

	test('empty gap yields empty ranges (one per epoch, no messages)', () => {
		const ranges = partitionGapByEpoch([], [5, 10, Number.POSITIVE_INFINITY]);
		expect(ranges).toHaveLength(2);
		expect(ranges.every((r) => r.messages.length === 0)).toBe(true);
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

describe('NIP-44 large-payload seal (nostr-tools override guard)', () => {
	// Regression guard for the `pnpm.overrides.nostr-tools` pin in package.json.
	// The multi-device seal reaches NIP-44 through applesauce-core's re-export
	// (`PrivateKeySigner` does `import { nip44 } from "applesauce-core/helpers/encryption"`,
	// which is `export { nip44 } from "nostr-tools"`). Applesauce pins
	// nostr-tools ~2.19 transitively — whose NIP-44 caps plaintext at 65535 bytes —
	// so a large MLS group-state document blew up as
	// `re-publish failed: invalid plaintext size: must be between 1 and 65535 bytes`.
	// The override forces the whole tree onto 2.23.9 (extended 6-byte length prefix,
	// 4 GB ceiling). If it is removed, this re-export re-binds to ~2.19 and throws.
	test('applesauce-core nip44 re-export encrypts + round-trips a >64 KB plaintext', async () => {
		const sk = generateSecretKey();
		const conversationKey = nip44.v2.utils.getConversationKey(sk, getPublicKey(sk));
		// 70 KB — comfortably past the old 65535-byte ceiling.
		const plaintext = 'x'.repeat(70_000);
		const payload = nip44.v2.encrypt(plaintext, conversationKey);
		expect(payload).not.toBe(plaintext);
		expect(nip44.v2.decrypt(payload, conversationKey)).toBe(plaintext);
	});
});

// ---------------------------------------------------------------------------
// Tip inventory (spec §4.3 XOR, §6)
// ---------------------------------------------------------------------------

function tipGroup(gid: string, address: string): TipGroupPointer {
	return { gid, address };
}

function tipOf(groups: TipGroupPointer[], metaAddress?: string): TipPointer {
	return { groups, metaAddress, servers: ['https://x'] };
}

describe('buildInventory (spec §4.3: live XOR tombstoned, never both at a tip)', () => {
	test('overlays re-sealed addresses onto fetched tip slots', () => {
		const pointer = tipOf([tipGroup('g1', 'old-addr')]);
		const inv = buildInventory(pointer, [tipGroup('g1', 'new-addr')], new Set());
		expect(inv).toEqual([tipGroup('g1', 'new-addr')]);
	});

	test('adds a re-sealed gid absent from the fetched tip (new group / stale peer)', () => {
		const pointer = tipOf([tipGroup('g1', 'a1')]);
		const inv = buildInventory(pointer, [tipGroup('g2', 'a2')], new Set());
		expect(inv).toEqual([tipGroup('g1', 'a1'), tipGroup('g2', 'a2')]);
	});

	test('drops a tombstoned gid from the fetched tip (§4.3)', () => {
		const pointer = tipOf([tipGroup('g1', 'a1'), tipGroup('g2', 'a2')]);
		const inv = buildInventory(pointer, [], new Set(['g1']));
		expect(inv).toEqual([tipGroup('g2', 'a2')]);
	});

	test('drops a tombstoned gid even when it was just re-sealed (§4.3 wins)', () => {
		// A soft-deleted gid that also appears in the re-seal set (e.g. a stale
		// peer tip carried it live) must still leave the inventory — §4.3 is the
		// single source of truth enforced once here.
		const pointer = tipOf([tipGroup('g1', 'old')]);
		const inv = buildInventory(pointer, [tipGroup('g1', 'fresh')], new Set(['g1']));
		expect(inv).toEqual([]);
	});

	test('empty inputs yield an empty inventory', () => {
		expect(buildInventory(tipOf([]), [], new Set())).toEqual([]);
	});
});

/**
 * Regression guard for the tombstone carry-forward fix in `publish` (§10.5).
 * The publish path computes `removed = compose(pending, carried, live)`, then
 * persists `removed` back as the new `carried`. The invariant that makes that
 * correct is idempotency: re-feeding the published union as `carried` (with no
 * new pending) reproduces the same union. If this fails, a meta-only republish
 * would silently drop tombstones fleet-wide — the original bug.
 */
describe('tombstone carry-forward idempotency (§10.5 durability)', () => {
	test('a published tombstone survives a subsequent meta-only republish', () => {
		// Publish 1: own soft-delete of G at epoch 5, nothing live.
		const published = composeTombstoneUnion([tombstone('g', 5)], [], []);
		expect(published).toContainEqual(tombstone('g', 5));
		// Publish 2: no new pending, the published union is now `carried`. G is still
		// not live, so the tombstone must carry forward unchanged.
		const republished = composeTombstoneUnion([], published, []);
		expect(republished).toContainEqual(tombstone('g', 5));
	});

	test('an adopted peer tombstone is dropped once the gid is present locally', () => {
		// Resurrection: a sibling Commit re-raises G's epoch, G is live again → the
		// XOR prunes the carried tombstone at the next publish (§8/§10).
		const carried = [tombstone('g', 5)];
		const republished = composeTombstoneUnion([], carried, ['g']);
		expect(republished).toEqual([]);
	});

	test('a higher-epoch rejoin tombstone supersedes a carried one', () => {
		const carried = [tombstone('g', 5)];
		// Same gid soft-deleted again at a higher epoch — highest wins (§8).
		const republished = composeTombstoneUnion([tombstone('g', 9)], carried, []);
		expect(republished).toEqual([tombstone('g', 9)]);
	});
});

// ---------------------------------------------------------------------------
// Publish carry-forward + reap bookkeeping (spec §10.5 + §12)
// ---------------------------------------------------------------------------

describe('planCarryForward (spec §10.5 durability + §12 reap)', () => {
	test('carries the published union forward and clears pending', () => {
		// Publish 1: own soft-delete of g1 (pending), nothing carried, nothing live.
		const next = planCarryForward({
			pendingTombstones: [tombstone('g1', 5)],
			carriedTombstones: [],
			liveGids: [],
			oldMetaAddress: 'meta-old',
			newMetaAddress: 'meta-new',
			pendingReap: []
		});
		expect(next.carriedTombstones).toEqual([tombstone('g1', 5)]);
		expect(next.pendingTombstones).toEqual([]);
	});

	test('queues the superseded meta for reap when the meta address changed', () => {
		const next = planCarryForward({
			pendingTombstones: [],
			carriedTombstones: [],
			liveGids: [],
			oldMetaAddress: 'meta-old',
			newMetaAddress: 'meta-new',
			pendingReap: []
		});
		expect(next.pendingReap).toEqual(['meta-old']);
	});

	test('does not queue reap when the meta address is unchanged', () => {
		// A meta re-seal that lands at the same address (e.g. identical content)
		// reaps nothing — there is no superseded blob to delete.
		const next = planCarryForward({
			pendingTombstones: [],
			carriedTombstones: [],
			liveGids: [],
			oldMetaAddress: 'meta-same',
			newMetaAddress: 'meta-same',
			pendingReap: []
		});
		expect(next.pendingReap).toEqual([]);
	});

	test('accumulates reap entries across publishes', () => {
		const next = planCarryForward({
			pendingTombstones: [],
			carriedTombstones: [],
			liveGids: [],
			oldMetaAddress: 'meta-2',
			newMetaAddress: 'meta-3',
			pendingReap: ['meta-1']
		});
		expect(next.pendingReap).toEqual(['meta-1', 'meta-2']);
	});

	test('resurrection prunes a carried tombstone when the gid is live again', () => {
		// A sibling-Commit re-raise makes g1 live → the XOR drops its carried
		// tombstone from the next carry-forward (§8/§10).
		const next = planCarryForward({
			pendingTombstones: [],
			carriedTombstones: [tombstone('g1', 5)],
			liveGids: ['g1'],
			oldMetaAddress: 'meta-old',
			newMetaAddress: 'meta-new',
			pendingReap: []
		});
		expect(next.carriedTombstones).toEqual([]);
	});

	test('no old meta address → nothing queued for reap', () => {
		// First-ever meta publish (no superseded address) reaps nothing.
		const next = planCarryForward({
			pendingTombstones: [],
			carriedTombstones: [],
			liveGids: [],
			oldMetaAddress: undefined,
			newMetaAddress: 'meta-first',
			pendingReap: []
		});
		expect(next.pendingReap).toEqual([]);
	});
});
