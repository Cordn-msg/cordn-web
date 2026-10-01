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
 * to (spec §4.2 + §11.5): it restores the coordinator list + the kp's
 * per-coordinator publish markers on link, which group seeding (§9) cannot
 * provide for a coordinator the identity has no groups on. Entries are public
 * keys only — relay hints travel per group (`coordinatorRelays`), not here.
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
	/**
	 * OPTIONAL (spec §4.1): relay URLs where `coordinator` is reachable, in the
	 * producer's preference order. Locator hints only (group-ref §4.3
	 * semantics): absent or empty means "no hint", and the consumer connects
	 * using its own relay configuration or discovery. Adopted fill-if-empty on
	 * seed/fast-forward — local relay configuration always wins (spec §9).
	 */
	coordinatorRelays?: string[];
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
	/** The writer's own saved relay configuration for that coordinator — the
	 *  publish side of spec §4.1 `coordinatorRelays`. Saved config only, never
	 *  the client-default fallback: a hint is never stamped with relays the
	 *  writer does not actually use. */
	coordinatorRelays?: string[];
	fetchCursor: number;
	/** High-water mark including own posted messages (spec §4.1: the document
	 *  cursor must cover every message folded into `state`, and own sends fold
	 *  in at send time while advancing only `lastCursor`). */
	lastCursor: number;
}

/** Per-group outcome of reconciliation (spec §8, §10). */
export type ReconcileOutcome = 'seeded' | 'fast-forwarded' | 'fork-resolved' | 'skipped';

/** The adopted group-document identity for a live group (spec §10 rank input). */
export interface AppliedDocument {
	/** Content address of the adopted document (tie-break input). */
	address: string;
	/** Document cursor carried at publish/adopt time (tie-break input). */
	cursor: number;
	/** Epoch fingerprint of the state it carried (spec §10 detection). */
	fingerprint?: string;
}

/**
 * Spec §10 detection: the epoch fingerprint of a state — `epoch`, `treeHash`
 * and `confirmedTranscriptHash` of the GroupContext (RFC 9420 §5.1), hex. Two
 * states with the same fingerprint are the same state; two at one epoch with
 * different fingerprints are two Commits from one base epoch. A re-publish
 * re-seals and changes the content address, never the fingerprint. Encoding
 * matches the reference implementation (cordn CLI `epochFingerprint`) so
 * conformance vectors can compare across clients.
 */
export function stateFingerprint(state: ClientState): string {
	const context = state.groupContext;
	return `${context.epoch.toString(16)}:${bytesToHex(context.treeHash)}:${bytesToHex(context.confirmedTranscriptHash)}`;
}

/** Where a fork decision came from (spec §10 resolution steps 1–3). */
export type ForkDecisionSource = 'coordinator-order' | 'third-party' | 'rank';

/** The recorded fork winner (spec §10: the rank alone never overturns it). */
export interface StoredForkDecision {
	/** The FORK epoch (the racing Commits' produced epoch) — not the document's. */
	epoch: string;
	/** Epoch fingerprint of the winning branch's state at resolution time. */
	fingerprint: string;
	by: ForkDecisionSource;
}

/** Pre-resolution application decision (spec §8 forward-only + §10 detection). */
export type ApplyDecision = 'seeded' | 'fast-forwarded' | 'skipped' | 'fork';

/**
 * Decide one group-document application up to the §10 fork resolution (spec
 * §8 forward-only + §10 detection). Pure: the caller decodes the document
 * first (undecodable → `skipped` without calling this) and resolves a `fork`
 * via `decideForkResolution`. Fork identity is the EPOCH FINGERPRINT, never the
 * content address: a re-publish of one state is advisory, not a fork.
 */
export function decideGroupDocumentApply(params: {
	incomingEpoch: bigint | undefined;
	localEpoch: bigint | undefined;
	incomingFingerprint?: string;
	localFingerprint?: string;
}): ApplyDecision {
	const { incomingEpoch, localEpoch, incomingFingerprint, localFingerprint } = params;
	if (incomingEpoch === undefined) return 'skipped'; // undecodable is advisory
	if (localEpoch === undefined) return 'seeded'; // absent → install (spec §8 case 1)
	if (incomingEpoch > localEpoch) return 'fast-forwarded'; // strictly newer (§8)
	if (incomingEpoch < localEpoch) return 'skipped'; // anti-downgrade (§8)
	// Equal epoch: the same state (a re-publish — advisory) or two Commits from
	// one base epoch (spec §10). The fingerprint tells them apart; the address
	// cannot, since a re-seal changes it while carrying the same state.
	if (incomingFingerprint !== undefined && incomingFingerprint === localFingerprint) {
		return 'skipped';
	}
	return 'fork';
}

/**
 * Resolve a §10 fork between the local state and the incoming document's
 * branch. The tier order is normative (spec §10 resolution): (1) the
 * coordinator-order branch mark — self-sufficient, since the racing loser
 * recorded `dead` and adopts while the winner recorded `live` and keeps;
 * (2) the third-party verdict; (3) a recorded decision (never overturned by
 * the rank alone), else the rank thunk (spec §10.3). The thunk may fetch
 * chains and is called ONLY where nothing else decides.
 */
export async function decideForkResolution(params: {
	forkEpoch: string;
	incomingFingerprint: string;
	branch?: { kind: 'live' | 'dead'; sinceEpoch: string };
	verdict?: boolean;
	recorded?: StoredForkDecision;
	rank: () => boolean | Promise<boolean>;
}): Promise<{ adopt: boolean; by: ForkDecisionSource }> {
	const { forkEpoch, incomingFingerprint, branch, verdict, recorded } = params;
	if (branch) return { adopt: branch.kind === 'dead', by: 'coordinator-order' };
	if (verdict !== undefined) return { adopt: verdict, by: 'third-party' };
	if (recorded && recorded.epoch === forkEpoch) {
		return { adopt: recorded.fingerprint === incomingFingerprint, by: recorded.by };
	}
	return { adopt: await params.rank(), by: 'rank' };
}

/** One walked `prev`-chain link for the §8 descent check. */
export interface ChainFingerprint {
	epoch: bigint;
	fingerprint: string;
}

/** Default cap on the retained epoch-fingerprint history (spec §8 descent check). */
export const RETAINED_FINGERPRINTS = 16;

/** Record a state's fingerprint in the group's held history (spec §10
 * detection; the §8 descent check compares chains against it). Copy-on-write;
 * the fingerprint is CONSTANT within an epoch (the GroupContext fields move
 * only on Commits), so any state seen at the epoch identifies its branch. */
export function noteStateFingerprint(
	held: Record<string, string> | undefined,
	state: ClientState,
	cap: number = RETAINED_FINGERPRINTS
): Record<string, string> {
	const next = { ...(held ?? {}) };
	next[state.groupContext.epoch.toString()] = stateFingerprint(state);
	const epochs = Object.keys(next)
		.map((epoch) => BigInt(epoch))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	for (const epoch of epochs.slice(0, Math.max(0, epochs.length - cap))) {
		delete next[epoch.toString()];
	}
	return next;
}

/**
 * Spec §8 descent check over a walked `prev` chain (newest first): does the
 * incoming document's branch descend from the local state? `descends` — the
 * chain passes through the local state at the local epoch (plain advance);
 * `forkedAt` — it meets a state this device held at an EARLIER epoch but never
 * its current one (the chain jumped over the local epoch): a fork that has
 * moved on, whatever the document's current epoch; `unknown` — no shared epoch
 * found (chain unreadable / not available to check) — the forward-only advance
 * applies (spec §8: liveness first).
 */
export function classifyChainDescent(
	chain: ChainFingerprint[],
	held: Record<string, string>,
	localEpoch: bigint
): 'descends' | { kind: 'forkedAt'; epoch: bigint } | 'unknown' {
	for (const link of chain) {
		if (link.epoch > localEpoch) continue;
		const ours = held[link.epoch.toString()];
		if (ours !== undefined && ours === link.fingerprint) {
			return link.epoch === localEpoch ? 'descends' : { kind: 'forkedAt', epoch: link.epoch };
		}
	}
	return 'unknown';
}

/** Rank inputs for one fork branch (spec §10.3). */
export interface ForkBranchRank {
	/** Lowest-cursor document at the fork epoch on the branch's chain — the
	 * commit-point document, whose cursor is that Commit's stream position (or
	 * the Commit's own cursor, for the device that authored it). */
	commit?: { cursor: number; address: string };
	/** The branch's live document — the fallback where no commit-point doc is known. */
	live?: { cursor: number; address: string };
}

/**
 * Spec §10.3 fork rank: `true` = adopt `theirs`. With commit-point docs on both
 * sides the LOWER commit cursor wins — the coordinator's order read off the
 * chains. Where a side has none, the live documents decide: higher cursor, then
 * the lexicographically greater content address. A side with no live document
 * loses to anything. Deterministic, commutative, idempotent — the shared floor.
 */
export function forkRankAdoptsTheirs(ours: ForkBranchRank, theirs: ForkBranchRank): boolean {
	if (ours.commit && theirs.commit) {
		return (
			theirs.commit.cursor < ours.commit.cursor ||
			(theirs.commit.cursor === ours.commit.cursor && theirs.commit.address > ours.commit.address)
		);
	}
	return (
		!ours.live ||
		!theirs.live ||
		theirs.live.cursor > ours.live.cursor ||
		(theirs.live.cursor === ours.live.cursor && theirs.live.address > ours.live.address)
	);
}

/** One failed group-document fetch awaiting retry (spec §8 fetch liveness). */
export interface UnresolvedDocumentPull {
	/** The tip address whose fetch failed. Cleared only when a fetch of this
	 *  address succeeds (a newer tip address supersedes it). */
	address: string;
	attempts: number;
	lastAttemptAt: number;
}

/** Retry backoff for failed pulls: 5s → 15s → 45s → 135s → 5min cap (spec §8). */
export function pullRetryDelayMs(attempts: number): number {
	return Math.min(5000 * 3 ** Math.max(attempts - 1, 0), 300_000);
}

/** Milliseconds until the SOONEST failed-pull retry is due (spec §8). One timer
 *  covers every failed gid, so it must fire for the earliest one — the later
 *  entries re-check their own backoff when it does. Non-empty entries. */
export function nextPullRetryDelayMs(entries: UnresolvedDocumentPull[], now: number): number {
	const dueAt = entries.map((entry) => entry.lastAttemptAt + pullRetryDelayMs(entry.attempts));
	return Math.max(0, Math.min(...dueAt) - now);
}

/**
 * Should this gid's document be fetched (spec §8 fetch liveness)? A tip
 * address matching the last-seen one is normally a no-op, EXCEPT for a gid
 * whose fetch failed — that must keep retrying (beyond backoff), or one
 * flaky fetch strands the device behind the fleet forever (the observed
 * incident: failed pull + tip dedup = permanent stranding).
 */
export function shouldReconcileGroupDocument(params: {
	lastSeenAddress?: string;
	tipAddress: string;
	unresolved?: UnresolvedDocumentPull;
	now: number;
}): boolean {
	const { lastSeenAddress, tipAddress, unresolved, now } = params;
	if (lastSeenAddress !== tipAddress) return true; // changed → always fetch
	if (!unresolved) return false; // unchanged + healthy → nothing to do
	if (unresolved.address !== tipAddress) return true; // tip moved since the failure
	return now - unresolved.lastAttemptAt >= pullRetryDelayMs(unresolved.attempts);
}

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
	 * epoch, resolve an equal-epoch fork (§10), or skip. A sibling Commit's new
	 * private keys travel here (§10) since the stream can't convey them
	 * (shared-leaf UpdatePath). `address` is the fetched document's content
	 * address (spec §10 fork identity) — omit only when unknown (pre-fork docs).
	 */
	applyGroupDocument(doc: GroupDocument, address?: string): Promise<ReconcileOutcome>;
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
	input: {
		gid: string;
		state: ClientState;
		coordinatorKey: string;
		/** Relay hints from the writer's own relay configuration (spec §4.1). */
		coordinatorRelays?: string[];
		fetchCursor: number;
		lastCursor: number;
	},
	prev?: string
): GroupDocument {
	return {
		schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
		type: 'group',
		gid: input.gid,
		coordinator: input.coordinatorKey,
		// Absent or empty means "no hint" (spec §4.1) — omit rather than emit [].
		...(input.coordinatorRelays?.length ? { coordinatorRelays: [...input.coordinatorRelays] } : {}),
		issuedAt: Date.now(),
		prev,
		clientState: bytesToBase64(encode(clientStateEncoder, input.state)),
		// §4.1 consistent snapshot at ratchet granularity: the cursor must cover
		// every message whose processing is folded into `state` — both inbound
		// stream messages (fetchCursor) and own posted messages, which ratchet
		// the state at send time but only advance lastCursor. Publishing
		// fetchCursor alone would understate the ratchet: an adopter would
		// re-process the writer's unechoed sends (spurious "Desired gen in the
		// past", their send generations are never retained) or, worse, treat a
		// ratchet-folded window as live-delivery territory.
		cursor: Math.max(input.fetchCursor, input.lastCursor)
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
	/** The epoch's commit point (spec §8.5 gen-0 state, §10.3 rank): the state
	 * right after this device's own Commit, at the Commit's cursor, pre-encoded.
	 * Published ahead of the live document, once, whenever the live state has
	 * moved past it — a sibling's catch-up can then open what arrived in between
	 * and the branch's Commit cursor is on record for the rank. */
	commitPoint?: { clientState: string; cursor: number; published?: boolean };
}): Promise<PublishResult & { cursor: number; commitPointPublished?: PublishResult }> {
	let prev = params.prev;
	let commitPointPublished: PublishResult | undefined;
	const commitPoint = params.commitPoint;
	if (commitPoint && !commitPoint.published && params.group.fetchCursor > commitPoint.cursor) {
		const pointDoc = {
			...buildGroupDocument(
				{
					gid: params.group.gid,
					state: params.group.state,
					coordinatorKey: params.group.coordinatorKey,
					coordinatorRelays: params.group.coordinatorRelays,
					fetchCursor: commitPoint.cursor,
					lastCursor: commitPoint.cursor
				},
				prev
			),
			// The stored commit-point state, byte-exact (never re-encoded — it is
			// `encode(clientStateEncoder, state)` from the Commit's adoption).
			clientState: commitPoint.clientState
		};
		commitPointPublished = await publishSealed(
			await sealDocument(pointDoc, params.seal, params.dekPubkey),
			params.store
		);
		prev = commitPointPublished.address;
	}
	const doc = buildGroupDocument(
		{
			gid: params.group.gid,
			state: params.group.state,
			coordinatorKey: params.group.coordinatorKey,
			coordinatorRelays: params.group.coordinatorRelays,
			fetchCursor: params.group.fetchCursor,
			lastCursor: params.group.lastCursor
		},
		prev
	);
	const sealed = await sealDocument(doc, params.seal, params.dekPubkey);
	const result = await publishSealed(sealed, params.store);
	// The published cursor rides along so the caller can record the document
	// identity (`AppliedDocument`) — the rank input for the spec §10 tie-break.
	return {
		...result,
		cursor: doc.cursor,
		...(commitPointPublished ? { commitPointPublished } : {})
	};
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
 * gen-0 ClientState. */
export interface GapRange<T extends { cursor: number }> {
	lo: number;
	hi: number;
	messages: T[];
}

/** Partition the catch-up message gap into per-epoch ranges (spec §8.5).
 * `boundaries` is `[decryptFrontier, ...chainCursors]` — the tip document's
 * cursor bounds the replay (spec §8.5 partition invariant: catch-up owns
 * `(localCursor, tipDoc.cursor]`; live delivery owns the tail past it, because
 * the live path both stores AND ratchets those messages). Range `i` covers
 * `(boundaries[i], boundaries[i+1]]` and pairs with `states[i]` in the caller
 * (`states` has one more element than the range count: the tip state is never
 * used for replay). Pure so the partitioning — the subtle part of chained
 * catch-up — is testable without the MLS / Blossom / orchestration surface. */
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
 * Gids whose local epoch is STRICTLY ahead of the last epoch known reflected by
 * the tip — the durable owed-push signal for changes stranded by a deferred,
 * failed, or process-killed publish (§10.5 offline "queue the change" + the
 * "on startup if local state is ahead of the tip" trigger). A stranded change
 * has no other visible signal: the tip's per-gid address never moved, so the
 * fetch-gated diff (`diffLocalAhead`) cannot see it. The record this diffs
 * against is written when a document is sealed by us (after the tip rewrite
 * lands on relays) or adopted from a peer; a §8 'skipped' outcome is
 * deliberately NOT recorded — a skip IS an owed push.
 *
 * STRICTLY ahead only: local below the record (a replayed-Welcome regression,
 * an old-backup restore) must not trigger a republish of stale state. Loop-safe
 * by construction: the heal publish records the sealed epoch, so a converged
 * device diffs to `[]`. Epochs compare numerically (BigInt) — they are stored
 * as strings for config-JSON safety and string order would rank '10' < '9'.
 */
export function diffStaleGroupEpochs(params: {
	localEpochs: Iterable<{ gid: string; epoch: string }>;
	publishedEpochs: Readonly<Record<string, string>> | undefined;
}): string[] {
	const published = params.publishedEpochs ?? {};
	const stale: string[] = [];
	for (const { gid, epoch } of params.localEpochs) {
		const recorded = published[gid];
		if (recorded !== undefined && BigInt(epoch) > BigInt(recorded)) stale.push(gid);
	}
	return stale.sort();
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

/** One coordinator's repair decision under the §11.5 resolution order. */
export type LastResortRepairPlan =
	| { kind: 'none' }
	| { kind: 'remark'; keyPackageRef: string }
	| { kind: 'publish'; keyPackageRef: string }
	| { kind: 'skip' };

/**
 * Plan the §11.5 resolution for one coordinator: converge "the coordinator's
 * served last-resort is processable by every device" onto (or from) the local
 * pick. Private key material never flows through the coordinator — the meta
 * document is the only channel that distributes it — so convergence is:
 * re-adopt the coordinator's entry when it is held locally (restoring its
 * publish claim, no coordinator write), else publish the pick (quota eviction
 * replaces the foreign entry; a Welcome already stored against it stays
 * processable by its holders since Welcome processing is local). `skip`
 * leaves untouched coordinators to the demand-driven publish path.
 */
export function planLastResortRepair(params: {
	/** Local canonical pick ref (published-first, newest-mint tie-break); absent → nothing to converge. */
	pickRef?: string;
	/** Ref the coordinator serves as our last-resort; absent when it holds none. */
	coordinatorLastResortRef?: string;
	/** The observation succeeded. Unverifiable (offline) → conservative none:
	 * absent from a response is not the same as unpublished. */
	reachable: boolean;
	/** The coordinator's served ref is held locally (adoption persistence). */
	heldLocally: boolean;
	/** The pick claims this coordinator (post-reconcile publish markers). */
	implicated: boolean;
}): LastResortRepairPlan {
	if (!params.pickRef || !params.reachable) return { kind: 'none' };
	const served = params.coordinatorLastResortRef;
	if (!served) {
		return params.implicated
			? { kind: 'publish', keyPackageRef: params.pickRef }
			: { kind: 'skip' };
	}
	if (served === params.pickRef) return { kind: 'none' };
	if (params.heldLocally) return { kind: 'remark', keyPackageRef: served };
	return { kind: 'publish', keyPackageRef: params.pickRef };
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
