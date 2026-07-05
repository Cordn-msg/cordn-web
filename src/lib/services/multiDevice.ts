/**
 * Multi-device session synchronization core (see
 * `cordn/spec/applications/multi-device.md`).
 *
 * Devices of one identity share a single MLS leaf per group. This module
 * snapshots a session's per-group `ClientState` and fetch cursor into a sealed
 * *session document*, content-addresses it, and lets another device of the
 * same identity fetch, decrypt, and seed the groups it is missing — then
 * converge via the normal coordinator delivery stream.
 *
 * Pure protocol/encoding core: no Svelte, no browser, no account coupling.
 * The NIP-44 seal, the content-addressed blob store, and the per-group
 * snapshot/apply are injected so the module is testable in isolation and the
 * service layer (`multiDevice.svelte.ts`) wires real account + Blossom +
 * storage. Mirrors `cordn/src/cli/multiDevice.ts`, swapping Node crypto for
 * `@noble/hashes` and the raw-private-key seal for an injected `Nip44Seal`
 * (so NIP-07/NIP-46 signers that expose `nip44` but never the `nsec` work).
 *
 * The document carries group state only (no `nsec`, no messages). The seal is
 * confidentiality-only; authenticity is provided by the tip (a sealed,
 * owner-signed inner Nostr event that points at the document address —
 * spec §6), implemented in the service layer.
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

import type { GroupMetadataInput } from '$lib/services/chatGroupLifecycle.svelte';

export const MULTI_DEVICE_SCHEMA_VERSION = 1;

/** NIP-44 v2 seal to the owner's own npub (spec §7). Confidentiality only. */
export interface Nip44Seal {
	/** Encrypt `plaintext` to `pubkey` (here: the owner's own). */
	encrypt(pubkey: string, plaintext: string): Promise<string>;
	/** Decrypt `ciphertext` addressed to `pubkey`. */
	decrypt(pubkey: string, ciphertext: string): Promise<string>;
}

/**
 * Minimal content-addressed blob store seam (Blossom in production). The
 * address is `sha256(blob)` lowercase hex (spec §6); `publish` returns the
 * URL the blob was stored at; `fetch` retrieves bytes by URL. The service
 * layer wires `chatBlossomClient.uploadBlob`/`fetchBlob`.
 */
export interface SessionBlobStore {
	publish(blob: Uint8Array): Promise<{ address: string; url: string }>;
	fetch(url: string): Promise<Uint8Array>;
}

export interface SessionGroupEntry {
	gid: string;
	coordinator: string;
	metadata?: GroupMetadataInput;
	encrypted: boolean;
	/** Base64 of `encode(clientStateEncoder, state)`. */
	clientState: string;
	/** Writer's last-processed delivery cursor for this `gid`. */
	cursor: number;
}

/**
 * Tombstone (spec §4 `removed[]`): records that the identity stopped tracking
 * `gid` when the group was at MLS `epoch`. `epoch` is a JSON number (MLS epochs
 * are small); compared as `BigInt` against `groupContext.epoch`. A `gid` appears
 * in `groups` XOR `removed`, never both in the same document.
 */
export interface SessionTombstone {
	gid: string;
	epoch: number;
}

export interface SessionDocument {
	schemaVersion: typeof MULTI_DEVICE_SCHEMA_VERSION;
	issuedAt: number;
	prev?: string;
	groups: SessionGroupEntry[];
	removed?: SessionTombstone[];
}

export class MultiDeviceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MultiDeviceError';
	}
}

/** A locally-known group, the view the document builder needs. */
export interface SessionGroupSnapshot {
	gid: string;
	state: ClientState;
	coordinatorKey: string;
	metadata?: GroupMetadataInput;
	/** True when the group uses end-to-end encrypted payloads (spec/03). */
	encrypted: boolean;
	fetchCursor: number;
}

/** Per-group outcome of reconciliation (spec §8). */
export type ReconcileOutcome = 'seeded' | 'fast-forwarded' | 'skipped';

/** Per-tombstone outcome of reconciliation (spec §8 case 4). */
export type ReconcileTombstoneOutcome = 'dropped' | 'ignored';

/**
 * Per-group local view used by reconciliation. The implementation (wired by
 * the service layer against `StoredChatGroup` + storage) decides whether an
 * entry seeds a missing group, fast-forwards a present group to a strictly
 * newer epoch, or is advisory. The forward-only epoch check (spec §8) is the
 * rollback defense and is load-bearing — implementations MUST NOT downgrade.
 */
export interface ReconcileTarget {
	/**
	 * Local epoch for `gid`, or `undefined` when the group is not present
	 * locally (the entry should seed it).
	 */
	localEpoch(gid: string): bigint | undefined;
	/** Apply one entry. Returns the outcome. */
	applyEntry(entry: SessionGroupEntry): Promise<ReconcileOutcome>;
	/**
	 * Apply one tombstone (spec §8 case 4): drop a local group whose epoch is
	 * ≤ the tombstone epoch; ignore a stale tombstone (epoch below local) or
	 * one for an unknown group. Returns `dropped` if a local group was removed.
	 */
	applyTombstone(tombstone: SessionTombstone): Promise<ReconcileTombstoneOutcome>;
}

// ---------------------------------------------------------------------------
// Canonical JSON + content addressing + sealing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON for content-addressing: object members sorted by name,
 * no insignificant whitespace. Sufficient for a stable `sha256` of a document
 * we control end-to-end (writer and reader share this encoder). Not full
 * RFC 8785 — big-number/string-escaping edge cases are irrelevant for the
 * document shape defined here, which is the only thing that is ever addressed.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/** `sha256` of the sealed payload's UTF-8 bytes, lowercase hex. Spec §6. */
export function documentAddress(sealedPayload: string): string {
	return bytesToHex(sha256(new TextEncoder().encode(sealedPayload)));
}

/** NIP-44 v2 encryption to the owner's own npub (spec §7). */
export async function sealDocument(
	doc: SessionDocument,
	seal: Nip44Seal,
	ownerPubkey: string
): Promise<string> {
	return seal.encrypt(ownerPubkey, canonicalJson(doc));
}

/** Decrypt and schema-validate a sealed document (spec §7). */
export async function openDocument(
	sealedPayload: string,
	seal: Nip44Seal,
	ownerPubkey: string
): Promise<SessionDocument> {
	const plaintext = await seal.decrypt(ownerPubkey, sealedPayload);
	const doc = JSON.parse(plaintext) as SessionDocument;
	if (doc.schemaVersion !== MULTI_DEVICE_SCHEMA_VERSION) {
		throw new MultiDeviceError(`Unsupported multi-device schema version: ${doc.schemaVersion}`);
	}
	// Authenticity lives in the tip (a sealed owner-signed inner event, spec
	// §6), not in the document: the seal is confidentiality-only (spec §7).
	return doc;
}

// ---------------------------------------------------------------------------
// Document construction
// ---------------------------------------------------------------------------

export function buildSessionDocument(params: {
	groups: SessionGroupSnapshot[];
	prev?: string;
	/**
	 * Tombstones carried in the published `removed` (spec §10.5 union): the
	 * device's own tombstones plus any adopted from the reconciled tip. A `gid`
	 * MUST NOT appear in both `groups` and `removed` (spec §4 XOR).
	 */
	removed?: SessionTombstone[];
}): SessionDocument {
	return {
		schemaVersion: MULTI_DEVICE_SCHEMA_VERSION,
		issuedAt: Date.now(),
		prev: params.prev,
		groups: params.groups.map((group) => ({
			gid: group.gid,
			coordinator: group.coordinatorKey,
			metadata: group.metadata,
			encrypted: group.encrypted,
			clientState: bytesToBase64(encode(clientStateEncoder, group.state)),
			cursor: group.fetchCursor
		})),
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

/**
 * Build + seal + publish the current session. `prev` forms the catch-up chain
 * (spec §4) — the caller tracks the last published address per owner.
 */
export async function publishCurrentSession(params: {
	groups: SessionGroupSnapshot[];
	seal: Nip44Seal;
	ownerPubkey: string;
	store: SessionBlobStore;
	prev?: string;
	/** Tombstones carried in the published `removed` (spec §10.5 union). */
	removed?: SessionTombstone[];
}): Promise<PublishResult> {
	const document = buildSessionDocument({
		groups: params.groups,
		prev: params.prev,
		removed: params.removed
	});
	const sealed = await sealDocument(document, params.seal, params.ownerPubkey);
	const blob = new TextEncoder().encode(sealed);
	const { address, url } = await params.store.publish(blob);
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
 * Fetch a sealed document by its content address. `addressToUrl` maps the
 * address to the store's URL scheme (Blossom: `https://<server>/<sha256>`).
 * Re-verifies `sha256(blob) == address` (spec §6 MUST) before unsealing.
 */
export async function pullSessionDocument(params: {
	address: string;
	store: SessionBlobStore;
	addressToUrl: (address: string) => string;
	seal: Nip44Seal;
	ownerPubkey: string;
}): Promise<SessionDocument> {
	const blob = await params.store.fetch(params.addressToUrl(params.address));
	const sealed = new TextDecoder().decode(blob);
	if (documentAddress(sealed) !== params.address) {
		throw new MultiDeviceError(
			'Document address mismatch: fetched blob does not match the advertised tip'
		);
	}
	return openDocument(sealed, params.seal, params.ownerPubkey);
}

/**
 * Seed-and-fast-forward reconciliation (spec §8). For each entry the target
 * either seeds a missing group, fast-forwards a present group to a strictly
 * newer epoch (never a downgrade — that is the rollback defense), or skips it
 * as advisory. Tombstones (spec §8 case 4) are processed AFTER groups so a
 * malformed doc that violates the §4 XOR rule still resolves removal-wins on
 * ties (§8). For well-formed docs (XOR) the order is irrelevant.
 *
 * ponytail: single-snapshot fast-forward only. The `prev`-chain walk
 * (spec §8.5) recovers messages a fast-forward would lose across skipped
 * sibling-commit epochs; ship that only when offline-during-sibling-commit
 * with messages is a reported data-loss case. `prev` is still WRITTEN so the
 * chain is walkable later — just not walked yet.
 */
export async function reconcileFromDocument(
	target: ReconcileTarget,
	document: SessionDocument
): Promise<{
	seeded: SessionGroupEntry[];
	fastForwarded: SessionGroupEntry[];
	skipped: SessionGroupEntry[];
	dropped: SessionTombstone[];
	ignored: SessionTombstone[];
}> {
	const seeded: SessionGroupEntry[] = [];
	const fastForwarded: SessionGroupEntry[] = [];
	const skipped: SessionGroupEntry[] = [];
	const dropped: SessionTombstone[] = [];
	const ignored: SessionTombstone[] = [];

	for (const entry of document.groups) {
		const outcome = await target.applyEntry(entry);
		if (outcome === 'seeded') seeded.push(entry);
		else if (outcome === 'fast-forwarded') fastForwarded.push(entry);
		else skipped.push(entry);
	}

	// Tombstones after groups (removal-wins-on-tie when §4 XOR is violated).
	// ponytail: no device-local tombstone memory — a tombstone for an unknown
	// group is carried forward by the caller via the published union (§10.5);
	// case 7 (refuse to re-seed from a stale peer that blind-pushes the group
	// as present) is enforced by the §10.5 reconcile-before-push discipline,
	// not by a local denylist.
	for (const tombstone of document.removed ?? []) {
		const outcome = await target.applyTombstone(tombstone);
		if (outcome === 'dropped') dropped.push(tombstone);
		else ignored.push(tombstone);
	}

	return { seeded, fastForwarded, skipped, dropped, ignored };
}

/** Decode an entry's `clientState` to read its epoch (used by §8 comparison). */
export function entryEpoch(entry: SessionGroupEntry): bigint | undefined {
	const decoded = clientStateDecoder(base64ToBytes(entry.clientState), 0);
	return decoded ? decoded[0].groupContext.epoch : undefined;
}

/**
 * Compose the published `removed` union (spec §10.5): own pending tombstones
 * plus any adopted from the reconciled tip, deduped per `gid` (highest epoch
 * wins), with the §4 XOR rule enforced — a `gid` present in local state is
 * alive, so its tombstone is dropped (a sibling Commit resurrected it, §10).
 * Pure: the caller passes the set of locally-present `gid`s.
 */
export function composeTombstoneUnion(
	pending: SessionTombstone[],
	adopted: SessionTombstone[],
	presentGids: Iterable<string>
): SessionTombstone[] {
	const present = new Set(presentGids);
	const byGid = new Map<string, SessionTombstone>();
	for (const t of [...pending, ...adopted]) {
		if (present.has(t.gid)) continue; // XOR: alive locally → not removed
		const prevT = byGid.get(t.gid);
		if (!prevT || t.epoch > prevT.epoch) byGid.set(t.gid, t);
	}
	return [...byGid.values()];
}
