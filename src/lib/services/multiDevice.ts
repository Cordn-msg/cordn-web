/**
 * Multi-device sync core (see `cordn/spec/applications/multi-device.md`).
 *
 * Two sealed, content-addressed document types: a *group document* per live
 * group (its `ClientState` + cursor, linked by a per-`gid` `prev` chain) and one
 * *meta document* per identity (last-resort key package + tombstones; no chain).
 * Each is NIP-44-sealed to a per-identity document encryption key (DEK, §7) — a
 * self-seal to the DEK's own pubkey — and addressed by `sha256(sealed)`; the tip
 * (§6) advertising them lives in the service layer.
 *
 * Pure core: no Svelte/browser/account coupling. The seal + blob store are
 * injected (testability; the DEK is a local keypair, so the service wires a
 * local NIP-44 self-seal, not the account signer). Documents carry group state
 * only; the seal is confidentiality-only (§7) — authenticity comes from the
 * owner-signed tip (§6), in the service.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from 'applesauce-core/helpers';
import {
	base64ToBytes,
	bytesToBase64,
	clientStateDecoder,
	clientStateEncoder,
	encode,
	type ClientState
} from 'ts-mls';

import {
	getCordnGroupMetadataExtension,
	type CordnGroupMetadata
} from '$lib/services/chatMlsUtils';

export const MULTI_DEVICE_SCHEMA_VERSION = 1;

/**
 * NIP-44 v2 self-seal to the DEK's own pubkey (spec §7). Confidentiality only.
 * The injected seal is bound to the DEK keypair; `pubkey` is the DEK's own
 * pubkey (sender = recipient = DEK). Authenticity comes from the owner-signed
 * tip (§6), never from the seal.
 */
export interface Nip44Seal {
	/** Encrypt `plaintext` to `pubkey` (the DEK's own, for the self-seal). */
	encrypt(pubkey: string, plaintext: string): Promise<string>;
	/** Decrypt `ciphertext` addressed to `pubkey`. */
	decrypt(pubkey: string, ciphertext: string): Promise<string>;
}

/**
 * Minimal content-addressed blob store seam (Blossom in production). The
 * address is `sha256(blob)` lowercase hex (spec §6); `publish` returns the URL
 * the blob was stored at; `fetch` retrieves bytes by URL. The service layer
 * wires `chatBlossomClient.uploadBlob`/`fetchBlob`.
 */
export interface BlobStore {
	publish(blob: Uint8Array): Promise<{ address: string; url: string }>;
	fetch(url: string): Promise<Uint8Array>;
}

export class MultiDeviceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MultiDeviceError';
	}
}

// ---------------------------------------------------------------------------
// Document shapes (spec §4)
// ---------------------------------------------------------------------------

/**
 * Tombstone (spec §4.2 `removed[]`): the identity stopped tracking `gid` when
 * the group was at MLS `epoch`. `epoch` is a JSON number (MLS epochs are
 * small); compared as `BigInt` against `groupContext.epoch`.
 */
export interface Tombstone {
	gid: string;
	epoch: number;
}

/**
 * Last-resort key package entry (spec §4.2). One per account (RFC 9420 §17.2);
 * replicates so any device can process a Welcome built against it.
 *
 * `coordinators` carries the coordinator pubkeys this last-resort is published
 * to (cordn-web's per-coordinator publish state). Spec §4.2's shape omits it —
 * the spec assumed coordinators are discovered via group seeding (§9), which
 * breaks for a last-resort published to a coordinator with no groups on it.
 * Carrying it here restores the coordinator list + the kp's per-coordinator
 * markers on link. Optional + forward-compatible (old clients ignore it); the
 * spec can adopt it alongside the tip-seal-sender reconciliation.
 *
 * NOTE: spec §4.2 specifies the TLS wire form (RFC 9420 §3) for `keyPackage`.
 * These fields hold the ts-mls library serialization (matching `clientState`,
 * which the spec explicitly defers to library serialization) — fine for the
 * current ts-mls-only fleet, but a cross-implementation Welcome path would need
 * the TLS wire form. Cross-impl interop is pending; tracked separately from the
 * spec divergence (tip seal sender) being reconciled in parallel.
 */
export interface LastResortKeyPackageEntry {
	keyPackage: string;
	privateKeyPackage: string;
	coordinators?: string[];
}

/**
 * One group document (spec §4.1): one per live group, per epoch. `prev` chains
 * per `gid`. `clientState` (base64) is the sole carrier of presentation state
 * — `CordnGroupMetadata` (spec/01) is a GroupContext extension inside it.
 */
export interface GroupDocument {
	schemaVersion: typeof MULTI_DEVICE_SCHEMA_VERSION;
	type: 'group';
	gid: string;
	coordinator: string;
	issuedAt: number;
	prev?: string;
	clientState: string;
	cursor: number;
}

/**
 * One meta document per identity (spec §4.2): a current-state set with NO
 * `prev` chain. Carries the account's last-resort key package and tombstones.
 */
export interface MetaDocument {
	schemaVersion: typeof MULTI_DEVICE_SCHEMA_VERSION;
	type: 'meta';
	issuedAt: number;
	lastResortKeyPackage?: LastResortKeyPackageEntry;
	removed?: Tombstone[];
}

export type MultiDeviceDocument = GroupDocument | MetaDocument;

// ---------------------------------------------------------------------------
// Local view + reconciliation seam
// ---------------------------------------------------------------------------

/** A locally-known group, the view the document builder needs. */
export interface GroupSnapshot {
	gid: string;
	state: ClientState;
	coordinatorKey: string;
	fetchCursor: number;
}

/** Per-group outcome of reconciliation (spec §8). */
export type ReconcileOutcome = 'seeded' | 'fast-forwarded' | 'skipped';

/** Per-tombstone outcome of reconciliation (spec §8 case 4). */
export type ReconcileTombstoneOutcome = 'dropped' | 'ignored';

/**
 * Per-group local view used by reconciliation (§8). Wired by the service layer
 * against `StoredChatGroup`. The forward-only epoch check is the rollback
 * defense and is load-bearing — implementations MUST NOT downgrade.
 */
export interface ReconcileTarget {
	/** Local epoch for `gid`, or `undefined` when absent (document should seed). */
	localEpoch(gid: string): bigint | undefined;
	/**
	 * Seed a missing group, fast-forward a present group to a strictly newer
	 * epoch, or skip. A sibling Commit's new private keys travel here (§10)
	 * since the stream can't convey them (shared-leaf UpdatePath).
	 */
	applyGroupDocument(doc: GroupDocument): Promise<ReconcileOutcome>;
	/** Apply one tombstone (§8): drop a local group whose epoch ≤ the tombstone
	 * epoch; ignore stale/unknown. Returns `dropped` if a local group was removed. */
	applyTombstone(tombstone: Tombstone): Promise<ReconcileTombstoneOutcome>;
	/** Load the meta document's last-resort key package (§11.5). */
	loadLastResortKeyPackage(entry: LastResortKeyPackageEntry): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Content addressing + sealing (spec §5, §6, §7)
// ---------------------------------------------------------------------------

/** `sha256` of the sealed payload's UTF-8 bytes, lowercase hex. Spec §6. */
export function documentAddress(sealedPayload: string): string {
	return bytesToHex(sha256(new TextEncoder().encode(sealedPayload)));
}

/** NIP-44 v2 self-seal to the DEK's own pubkey (spec §7). */
export async function sealDocument(
	doc: MultiDeviceDocument,
	seal: Nip44Seal,
	dekPubkey: string
): Promise<string> {
	// Spec §5: no canonical JSON — NIP-44's random salt means identical plaintext
	// seals to different ciphertext/address each time, so canonicalization enables
	// neither addressing nor dedup.
	return seal.encrypt(dekPubkey, JSON.stringify(doc));
}

/** Decrypt and validate a sealed document. Dispatches on `type`. Spec §7. */
export async function openDocument(
	sealedPayload: string,
	seal: Nip44Seal,
	dekPubkey: string
): Promise<MultiDeviceDocument> {
	const plaintext = await seal.decrypt(dekPubkey, sealedPayload);
	const doc = JSON.parse(plaintext) as MultiDeviceDocument;
	if (doc.schemaVersion !== MULTI_DEVICE_SCHEMA_VERSION) {
		throw new MultiDeviceError(`Unsupported multi-device schema version: ${doc.schemaVersion}`);
	}
	// Authenticity lives in the tip (a sealed owner-signed inner event, spec
	// §6), not in the document: the seal is confidentiality-only (spec §7).
	if (doc.type !== 'group' && doc.type !== 'meta') {
		throw new MultiDeviceError(`Unknown document type: ${String((doc as { type?: string }).type)}`);
	}
	return doc;
}

// ---------------------------------------------------------------------------
// Document construction (spec §4.1, §4.2)
// ---------------------------------------------------------------------------

function buildGroupDocument(
	input: { gid: string; state: ClientState; coordinatorKey: string; fetchCursor: number },
	prev?: string
): GroupDocument {
	return {
		schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
		type: 'group',
		gid: input.gid,
		coordinator: input.coordinatorKey,
		issuedAt: Date.now(),
		prev,
		clientState: bytesToBase64(encode(clientStateEncoder, input.state)),
		cursor: input.fetchCursor
	};
}

function buildMetaDocument(params: {
	lastResortKeyPackage?: LastResortKeyPackageEntry;
	removed?: Tombstone[];
}): MetaDocument {
	return {
		schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
		type: 'meta',
		issuedAt: Date.now(),
		lastResortKeyPackage: params.lastResortKeyPackage,
		removed: params.removed
	};
}

// ---------------------------------------------------------------------------
// High-level publish / pull / reconcile
// ---------------------------------------------------------------------------

export interface PublishResult {
	/** `sha256` of the sealed payload — the content address / tip value. */
	address: string;
	/** Store URL the blob was published at. */
	url: string;
}

/** Publish-and-verify tail shared by group + meta publishes (spec §6 MUST). */
async function publishSealed(sealed: string, store: BlobStore): Promise<PublishResult> {
	const blob = new TextEncoder().encode(sealed);
	const { address, url } = await store.publish(blob);
	// ponytail: trust the store's claimed sha256 only after re-deriving it from
	// the bytes we sealed — same content-addressing MUST as the read side.
	const derived = documentAddress(sealed);
	if (derived !== address) {
		throw new MultiDeviceError(
			'Store returned an address that does not match sha256(sealed document)'
		);
	}
	return { address, url };
}

/**
 * Publish one group document, extending its per-`gid` `prev` chain (§10.5: a
 * group change republishes only that group's doc). `prev` is the current tip
 * address for this `gid` (read from the reconciled tip; no persistent root).
 */
export async function publishGroupDocument(params: {
	group: GroupSnapshot;
	seal: Nip44Seal;
	dekPubkey: string;
	store: BlobStore;
	prev?: string;
}): Promise<PublishResult> {
	const doc = buildGroupDocument(
		{
			gid: params.group.gid,
			state: params.group.state,
			coordinatorKey: params.group.coordinatorKey,
			fetchCursor: params.group.fetchCursor
		},
		params.prev
	);
	const sealed = await sealDocument(doc, params.seal, params.dekPubkey);
	return publishSealed(sealed, params.store);
}

/** Publish the meta document (§4.2): a current-state set with no `prev`. A
 * tombstone/key-package change republishes only this doc + its `meta` x-tag (§10.5). */
export async function publishMetaDocument(params: {
	seal: Nip44Seal;
	dekPubkey: string;
	store: BlobStore;
	removed?: Tombstone[];
	lastResortKeyPackage?: LastResortKeyPackageEntry;
}): Promise<PublishResult> {
	const doc = buildMetaDocument({
		lastResortKeyPackage: params.lastResortKeyPackage,
		removed: params.removed
	});
	const sealed = await sealDocument(doc, params.seal, params.dekPubkey);
	return publishSealed(sealed, params.store);
}

/**
 * Fetch a document by its content address. `addressToUrl` maps the address to
 * the store's URL scheme (Blossom: `https://<server>/<sha256>`). Re-verifies
 * `sha256(blob) == address` (spec §6 MUST) before unsealing.
 */
export async function pullDocument(params: {
	address: string;
	store: BlobStore;
	addressToUrl: (address: string) => string;
	seal: Nip44Seal;
	dekPubkey: string;
}): Promise<MultiDeviceDocument> {
	const blob = await params.store.fetch(params.addressToUrl(params.address));
	const sealed = new TextDecoder().decode(blob);
	if (documentAddress(sealed) !== params.address) {
		throw new MultiDeviceError(
			'Document address mismatch: fetched blob does not match the advertised tip'
		);
	}
	return openDocument(sealed, params.seal, params.dekPubkey);
}

/**
 * Apply a meta document: drop tombstoned groups (§8) + load the last-resort key
 * package (§11.5). Tombstone order is irrelevant for a well-formed meta doc.
 */
export async function reconcileMetaDocument(
	target: ReconcileTarget,
	doc: MetaDocument
): Promise<{ dropped: Tombstone[]; ignored: Tombstone[]; keyPackageLoaded: boolean }> {
	const dropped: Tombstone[] = [];
	const ignored: Tombstone[] = [];
	for (const tombstone of doc.removed ?? []) {
		const outcome = await target.applyTombstone(tombstone);
		// ponytail: no device-local tombstone memory — a tombstone for an unknown
		// group is carried forward by the caller via the published union (§10.5);
		// the §10.5 reconcile-before-push discipline keeps a stale peer from
		// resurrecting it by blind-pushing the group as present.
		(outcome === 'dropped' ? dropped : ignored).push(tombstone);
	}
	const keyPackageLoaded = doc.lastResortKeyPackage
		? await target.loadLastResortKeyPackage(doc.lastResortKeyPackage)
		: false;
	return { dropped, ignored, keyPackageLoaded };
}

// ---------------------------------------------------------------------------
// Group-state decode helpers (spec §4: metadata lives in clientState)
// ---------------------------------------------------------------------------

/** Decode a group document's `clientState` epoch (used by §8 comparison). */
export function groupEpoch(doc: GroupDocument): bigint | undefined {
	const decoded = clientStateDecoder(base64ToBytes(doc.clientState), 0);
	return decoded ? decoded[0].groupContext.epoch : undefined;
}

/** Derive a group's presentation metadata from its `clientState` (§9 step 2):
 * `CordnGroupMetadata` is a GroupContext extension, not a document field (§4). */
export function groupMetadata(doc: GroupDocument): CordnGroupMetadata | undefined {
	const decoded = clientStateDecoder(base64ToBytes(doc.clientState), 0);
	return decoded ? getCordnGroupMetadataExtension(decoded[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Per-group chained catch-up (spec §8.5)
// ---------------------------------------------------------------------------

/** One step of a walked `prev` chain (spec §8.5): a gen-0 `ClientState` for an epoch strictly newer than local. */
export interface ChainStep {
	/** MLS epoch of `clientState` (decoded). */
	epoch: bigint;
	/** Base64 `ClientState` for this epoch (spec §4.1 `clientState`). */
	clientState: string;
	/** Writer's cursor when this epoch's doc was published — epoch boundary for
	 * partitioning the catch-up message gap. */
	cursor: number;
	/** Content address of the document this step was read from. */
	address: string;
}

/**
 * Walk one group's `prev` chain (§4.1) backward from the tip, collecting one
 * gen-0 `ClientState` per epoch strictly newer than `localEpoch`. Authenticity
 * is transitive (tip §6 → each `prev` → `sha256` re-checked per hop). Keeps the
 * OLDEST doc per epoch (smallest cursor = gen-0; a newer same-epoch doc has an
 * advanced ratchet and can't derive earlier generations). Sorted ascending by
 * cursor so callers partition the message gap at chain cursors.
 * ponytail: bounded to 1000 hops; a deeper gap should single-snapshot
 * fast-forward (§10). Sibling-Commits aren't applied — caller skips them.
 */
export async function walkGroupChain(params: {
	tipAddress: string;
	groupId: string;
	localEpoch: bigint;
	store: BlobStore;
	addressToUrl: (address: string) => string;
	seal: Nip44Seal;
	dekPubkey: string;
}): Promise<ChainStep[]> {
	const byEpoch = new Map<bigint, ChainStep>();
	let address: string | undefined = params.tipAddress;
	for (let hop = 0; hop < 1000 && address; hop++) {
		const doc = await pullDocument({
			address,
			store: params.store,
			addressToUrl: params.addressToUrl,
			seal: params.seal,
			dekPubkey: params.dekPubkey
		});
		// The chain is per-gid: stop at a meta doc or a different group's doc.
		if (doc.type !== 'group' || doc.gid !== params.groupId) break;
		const epoch = groupEpoch(doc);
		if (epoch === undefined || epoch <= params.localEpoch) break; // reached local-or-older state
		const existing = byEpoch.get(epoch);
		if (!existing || doc.cursor < existing.cursor) {
			byEpoch.set(epoch, {
				epoch,
				clientState: doc.clientState,
				cursor: doc.cursor,
				address
			});
		}
		address = doc.prev;
	}
	return [...byEpoch.values()].sort((a, b) => a.cursor - b.cursor);
}

/** One epoch's slice of the catch-up gap (spec §8.5). Range is half-open
 * `(lo, hi]` — messages whose `cursor` falls in it decrypt with that epoch's
 * gen-0 ClientState. `hi === +Infinity` for the final (tip) epoch. */
export interface GapRange<T extends { cursor: number }> {
	lo: number;
	hi: number;
	messages: T[];
}

/** Partition the catch-up message gap into per-epoch ranges (spec §8.5).
 * `boundaries` is `[decryptFrontier, ...chainCursors, +Infinity]`; range `i`
 * covers `(boundaries[i], boundaries[i+1]]` and pairs with `states[i]` in the
 * caller (`states` has one fewer element than `boundaries`). Pure so the
 * partitioning — the subtle part of chained catch-up — is testable without the
 * MLS / Blossom / orchestration surface. */
export function partitionGapByEpoch<T extends { cursor: number }>(
	gap: T[],
	boundaries: number[]
): GapRange<T>[] {
	const ranges: GapRange<T>[] = [];
	for (let i = 0; i + 1 < boundaries.length; i++) {
		const lo = boundaries[i]!;
		const hi = boundaries[i + 1]!;
		ranges.push({ lo, hi, messages: gap.filter((m) => m.cursor > lo && m.cursor <= hi) });
	}
	return ranges;
}

/**
 * Published `removed` union (§10.5): own pending + adopted tombstones, deduped
 * per `gid` (highest epoch wins), with the §4.3 XOR — a `gid` present locally
 * is alive, so its tombstone is dropped (sibling-Commit resurrection, §10).
 */
export function composeTombstoneUnion(
	pending: Tombstone[],
	adopted: Tombstone[],
	presentGids: Iterable<string>
): Tombstone[] {
	const present = new Set(presentGids);
	const byGid = new Map<string, Tombstone>();
	for (const t of [...pending, ...adopted]) {
		if (present.has(t.gid)) continue; // XOR: alive locally → not removed
		const prevT = byGid.get(t.gid);
		if (!prevT || t.epoch > prevT.epoch) byGid.set(t.gid, t);
	}
	return [...byGid.values()];
}

// ---------------------------------------------------------------------------
// Tip inventory (spec §4.3, §6)
// ---------------------------------------------------------------------------

/** One live group document's tip entry (spec §6 `['x', sha256, 'group', gid]`). */
export interface TipGroupPointer {
	/** Group document content address (spec §6 `x` tagged `group`). */
	address: string;
	/** Delivery group id the document is for — enables fetch-only-changed. */
	gid: string;
}

/** The tip's document inventory (spec §6): live group pointers + meta + servers. */
export interface TipPointer {
	groups: TipGroupPointer[];
	metaAddress?: string;
	servers: string[];
}

/**
 * Build the tip's group inventory (§4.3): start from the fetched tip's slots
 * (peer addresses), drop tombstoned gids, then overlay the freshly re-sealed
 * addresses. A re-sealed gid absent from the fetched tip (newly created, or a
 * stale peer tip) is added. §4.3 (a gid appears live XOR tombstoned, never both
 * at the same tip) is enforced here, once, for every publish.
 *
 * Caller contract: every gid in `tombstonedGids` MUST also be carried in the
 * meta document this tip points at — otherwise a sibling reading the tip sees
 * the gid vanish from the group list with no tombstone to explain it, and the
 * read-path `missingFromTip` diff resurrects it (flip-flop). The service layer
 * upholds this by only populating `pendingTombstones` inside a meta-publishing
 * serialized op (see `MultiDeviceOwnerConfig.pendingTombstones` invariant).
 */
export function buildInventory(
	pointer: TipPointer,
	resealed: TipGroupPointer[],
	tombstonedGids: Set<string>
): TipGroupPointer[] {
	const inv: TipGroupPointer[] = [];
	for (const g of pointer.groups) {
		if (tombstonedGids.has(g.gid)) continue; // §4.3: tombstoned gid leaves the tip
		inv.push(resealed.find((r) => r.gid === g.gid) ?? g); // overlay re-sealed address
	}
	for (const r of resealed) {
		if (tombstonedGids.has(r.gid)) continue;
		if (!pointer.groups.some((g) => g.gid === r.gid)) inv.push(r); // new / stale-peer-tip
	}
	return inv;
}

// ---------------------------------------------------------------------------
// Read-path divergence diff (spec §8 + §10.5 "local ahead of tip")
// ---------------------------------------------------------------------------

/**
 * Local-ahead-of-tip diff (spec §8: "a device that holds newer local state —
 * groups the tip lacks, or higher local epochs — SHOULD re-publish"; §10.5
 * trigger: "on startup if local state is ahead of the tip"). Pure so the loop-
 * safety + resurrection semantics are testable without the MLS/Blossom surface.
 *
 * Two signals, neither requiring an extra fetch on the read path:
 *  - `missingFromTip`: local live gids absent from the tip's group list. A gid
 *    tombstoned-stale on the tip (epoch below local) is not in the tip's group
 *    list, so it lands here — republishing it is the §8 resurrection, correct.
 *  - `epochsAhead`: gids the reconcile just fetched and found at a local epoch
 *    ≥ the document's epoch (the `'skipped'` outcome of §8). The caller collects
 *    these during `applyTip`; no decode happens here.
 *
 * Returns the deduped, sorted union — the gids a read path should re-seal.
 * Loop-safe by construction: once the device pushes the missing groups, the next
 * tip read finds every local gid present at a matching epoch and returns `[]`.
 */
export function diffLocalAhead(params: {
	localGids: Iterable<string>;
	tipGids: Iterable<string>;
	epochsAheadGids: Iterable<string>;
}): string[] {
	const tipSet = new Set(params.tipGids);
	const ahead = new Set<string>();
	for (const gid of params.localGids) {
		if (!tipSet.has(gid)) ahead.add(gid); // live locally, absent from the tip
	}
	for (const gid of params.epochsAheadGids) {
		ahead.add(gid); // fetched + local epoch ≥ document epoch (§8 skip)
	}
	return [...ahead].sort();
}

/**
 * Deterministic content hash of the meta view that gets published (§4.2):
 * `lastResortKeyPackage` + the composed `removed` set. Excludes `issuedAt`
 * (which changes every publish) so the hash is a stable signal for "did the
 * published meta content change," unlike the meta document address (which is
 * over the sealed blob and varies with NIP-44's salt). Used by the read path to
 * detect that local meta state diverged from the tip: the local hash is
 * recomputed on every tip read and compared to the hash recorded for the meta
 * content currently believed to be on the tip (recorded on both publish AND
 * adopt, so a freshly-adopted meta doesn't look "ahead"). Canonical (sorted)
 * so semantically-equal views hash equal.
 *
 * Pure + local-only: the hash never leaves the device. It carries the
 * `privateKeyPackage` because that field IS part of the published meta doc and
 * so affects its content-addressed address — excluding it would miss a rotation.
 */
export function metaViewHash(params: {
	lastResortKeyPackage?: LastResortKeyPackageEntry;
	removed?: Tombstone[];
}): string {
	const removed = [...(params.removed ?? [])].sort((a, b) =>
		a.gid === b.gid ? a.epoch - b.epoch : a.gid < b.gid ? -1 : 1
	);
	const kp = params.lastResortKeyPackage
		? {
				keyPackage: params.lastResortKeyPackage.keyPackage,
				privateKeyPackage: params.lastResortKeyPackage.privateKeyPackage,
				coordinators: [...(params.lastResortKeyPackage.coordinators ?? [])].sort()
			}
		: undefined;
	return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ kp, removed }))));
}

/** Next carry-forward + reap state after a publish (spec §10.5 + §12). Pure so
 * the tombstone-durability invariants — pending cleared, the just-published
 * `removed` union carried forward, a superseded meta queued for reap exactly
 * once — are testable without the publish orchestration. The caller gates this
 * on a meta re-seal (`if (plan.resealMeta)`); a group-only publish leaves
 * tombstone state untouched by not calling. */
export function planCarryForward(params: {
	pendingTombstones: Tombstone[];
	carriedTombstones: Tombstone[];
	liveGids: string[];
	/** Meta address before this publish (the one being superseded), if any. */
	oldMetaAddress?: string;
	/** Meta address after this publish. */
	newMetaAddress?: string;
	pendingReap: string[];
}): { carriedTombstones: Tombstone[]; pendingTombstones: Tombstone[]; pendingReap: string[] } {
	const removed = composeTombstoneUnion(
		params.pendingTombstones,
		params.carriedTombstones,
		params.liveGids
	);
	const superseded =
		params.oldMetaAddress !== undefined && params.oldMetaAddress !== params.newMetaAddress
			? params.oldMetaAddress
			: null;
	return {
		carriedTombstones: removed,
		pendingTombstones: [],
		pendingReap: superseded ? [...params.pendingReap, superseded] : params.pendingReap
	};
}
