/**
 * Multi-device sync service (see `multiDevice.ts` for the pure core,
 * `cordn/spec/applications/multi-device.md` for the spec).
 *
 * Owns the per-owner config (enable flag, once-generated ephemeral signing key
 * + stable `d`, editable relay set) in localStorage. Wires the pure core to the
 * account signer, Blossom, the group store, and the relay pool.
 *
 * Tip transport (§6): a replaceable `kind:30078` signed by the ephemeral key,
 * whose content is a NIP-44 seal (to the owner npub) of an owner-signed inner
 * `kind:178` carrying typed `x` tags (`['x', sha256, 'group', gid]` per live
 * group + `['x', sha256, 'meta']`) + ordered `server` tags. Owner npub never
 * appears on the wire. Connection string (§11) = naddr + ephemeral write key.
 *
 * Re-publish hooks (§10): `onGroupStateAdvance(gid)` + `onMetaStateChange()`,
 * fire-and-forget, no-ops when disabled or no signer/seal.
 */
import { browser, dev } from '$app/environment';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';

import { manager } from '$lib/services/accountManager.svelte';
import { relayPool } from '$lib/services/relay-pool';
import { eventStore } from '$lib/services/eventStore';
import { mapEventsToStore } from 'applesauce-core/observable';
import { nip44 } from 'applesauce-core/helpers/encryption';
import {
	uploadBlob,
	fetchBlob,
	deleteBlob,
	type BlossomSigner,
	type UploadedBlob
} from '$lib/services/chatBlossomClient';
import { BLOSSOM_SERVERS } from '$lib/constants/chat';
import {
	listChatGroups,
	getChatGroup,
	persistGroup,
	replaceGroup,
	deleteChatGroup,
	decodeStoredGroupState,
	runGroupOperation,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import { getChatCoordinator, markCoordinatorUsed } from '$lib/services/chatCoordinators.svelte';
import { getProtocolGroupId } from '$lib/services/chatGroupLifecycle.svelte';
import { requireActiveAccount, withCoordinatorClient } from '$lib/services/chatRuntime';
import {
	ingestChatGroupMessages,
	probeSealedMessage
} from '$lib/services/chatGroupMessages.svelte';
import { createWorkingChatGroupSession } from '$lib/services/chatGroupSessions.svelte';
import { errorMessage, normalizePubKey } from '$lib/utils';
import { base64ToBytes, clientStateDecoder, type ClientState } from 'ts-mls';
import {
	MultiDeviceError,
	publishGroupDocument,
	publishMetaDocument,
	pullDocument,
	reconcileMetaDocument,
	composeTombstoneUnion,
	decideGroupDocumentApply,
	decideForkResolution,
	classifyChainDescent,
	forkRankAdoptsTheirs,
	noteStateFingerprint,
	stateFingerprint,
	groupEpoch,
	groupMetadata,
	walkGroupChain,
	buildInventory,
	partitionGapByEpoch,
	planCarryForward,
	diffLocalAhead,
	diffStaleGroupEpochs,
	metaViewHash,
	nextPullRetryDelayMs,
	shouldReconcileGroupDocument,
	type UnresolvedDocumentPull,
	type Nip44Seal,
	type BlobStore,
	type GroupDocument,
	type GroupSnapshot,
	type MetaDocument,
	type Tombstone,
	type ReconcileTarget,
	type ReconcileOutcome,
	type StoredForkDecision,
	type ForkBranchRank,
	type ChainFingerprint,
	type ChainStep,
	type TipGroupPointer,
	type TipPointer
} from '$lib/services/multiDevice';
import {
	getLastResortKeyPackageEntry,
	loadLastResortKeyPackage,
	repairLastResortAlignment
} from '$lib/services/chatKeyPackages.svelte';

/**
 * Outer replaceable event kind (spec §14 — a coordination detail all clients
 * must agree on). The exact value is a coordination detail; this is cordn-web's
 * choice for the opaque tip transport.
 */
export const MULTI_DEVICE_TIP_KIND = 30078;
/** Inner, sealed, owner-signed event kind (self-labeling; never relayed). */
const MULTI_DEVICE_INNER_KIND = 178;

const CONFIG_STORAGE_KEY = 'cordn.multiDevice';

/**
 * Default tip relays: 3 for locator redundancy (spec §6) — one relay dropping
 * the tip event must not strand linked devices. Editable in Advanced.
 */
export const DEFAULT_MULTI_DEVICE_RELAYS = [
	'wss://relay.nostr.net',
	'wss://relay.ditto.pub/',
	'wss://relay.primal.net'
];

/**
 * Default document hosts: 3-way replication so a single server outage can't
 * strand the sealed document. Editable in Advanced.
 */
export const DEFAULT_BLOSSOM_SERVERS = [
	'https://cdn.hzrd149.com/',
	'https://blossom.ditto.pub/',
	'https://blossom.primal.net/'
];

/**
 * Dev-only debug log. Filter the console by `[multi-device]` to trace the
 * enable/disable → save → publish → reconcile flow. Silent in production —
 * `dev` is the SvelteKit dev-server flag (not NODE_ENV/MODE), so dbg only
 * fires under `pnpm dev`. Add a `localStorage` read on top if prod debug is
 * ever needed.
 */
function dbg(label: string, detail?: unknown): void {
	if (!browser || !dev) return;
	console.debug('[multi-device]', label, detail ?? '');
}

/**
 * Session-only progress for user-initiated multi-device operations (linking a
 * device, enabling / bulk-publishing). Reactive so the config UI can render a bar
 * + one-liner. `phase` is the active label, or null when idle — the gate the
 * shared reconcilers check before updating. Background subscription cycles and
 * steady-state single-group publishes leave phase null, so they never surface a
 * bar. Cleared by the activating flow on completion or error.
 */
export interface MultiDeviceProgress {
	phase: string | null;
	current: number;
	total: number;
}
export const mdProgress = $state<MultiDeviceProgress>({ phase: null, current: 0, total: 0 });

/** Activate a phase (and optional i/N total). Idle when phase is null. */
function setMdProgress(phase: string, current = 0, total = 0): void {
	mdProgress.phase = phase;
	mdProgress.current = current;
	mdProgress.total = total;
}

function clearMdProgress(): void {
	mdProgress.phase = null;
}

/** Advance the in-flight item counter — a no-op unless a flow activated progress. */
function bumpMdProgress(current: number): void {
	if (mdProgress.phase) mdProgress.current = current;
}

/** Per-owner multi-device config. Keyed by owner pubkey in localStorage. */
export interface MultiDeviceOwnerConfig {
	/**
	 * The owner pubkey this config belongs to (normalized). Captured at creation
	 * so `saveConfig` writes to THIS account's slot — not whatever account happens
	 * to be active when a long-running publish/write-back completes. Without it,
	 * an account switch during an in-flight publish (relay fetch + Blossom uploads
	 * span multiple awaits) would land the in-flight config in the new account's
	 * slot, leaking the ephemeral write key + DEK across identities. Backfilled on
	 * read for configs created before the field existed (pre-release dev state).
	 */
	ownerPubkey: string;
	/** Stable opaque `d` for the replaceable tip event. Generated once. */
	dTag: string;
	/** Ephemeral signing key for the outer tip event + Blossom auth (hex nsec). */
	ephemeralPrivateKey: string;
	/** Derived once from `ephemeralPrivateKey`. */
	ephemeralPubkey: string;
	/**
	 * Per-identity document encryption key (DEK, spec §7) private key — 64 hex
	 * chars. A fresh Nostr keypair generated once per identity; documents are
	 * NIP-44 self-sealed to its pubkey so decrypts are local (no signer round
	 * trip). The source device generates it; a linked device reads it from the
	 * tip's `dek` tag on first reconcile. Optional only pre-first-tip-read.
	 */
	dekPrivateKey?: string;
	/** Editable relay set the tip is published/subscribed on. */
	relays: string[];
	/** Blossom server URLs that host the sealed documents (ordered, most-reliable first). */
	blossomServers: string[];
	/**
	 * Last-seen tip addresses (§6: persist last-seen `x` per `gid` + `meta` to
	 * diff + fetch only what changed). Survives reload; also the §10.5 offline-
	 * defer signal — if set, a tip is out there we could clobber, so defer the
	 * push when the tip is briefly unreachable. Servers excluded (live tip each read).
	 */
	lastSeenTip?: { groups: TipGroupPointer[]; metaAddress?: string };
	/**
	 * Outer tip event id last seen (§10.5 Tip-address check). An id we've processed
	 * is self-echo / duplicate relay delivery → `handleTipEvent` skips it.
	 * Persisted BEFORE the relay publish so loopback short-circuits.
	 */
	lastSeenTipEventId?: string;
	/**
	 * Per-gid failed group-document fetches awaiting retry (spec §8 fetch
	 * liveness). A gid listed here is NOT reconciled: the dedup gates must keep
	 * re-pulling it (beyond backoff) until a fetch succeeds — the observed
	 * incident was one failed pull + tip dedup = permanent stranding.
	 */
	unresolvedDocumentPulls?: Record<string, UnresolvedDocumentPull>;
	/**
	 * Per-gid epoch of group state known reflected by the tip (§10.5 owed-push
	 * record): written when we seal a document — only after the tip rewrite
	 * lands on relays — or adopt a peer document. A §8 'skipped' outcome is
	 * deliberately NOT written — a skip is local ahead of the tip, i.e. an owed
	 * push. The strictly-ahead diff vs this record (`diffStaleGroupEpochs`)
	 * heals changes stranded by a deferred / failed / process-killed publish;
	 * absent entry = unknown = quiet (no migration: a pre-existing strand stays
	 * as stranded as today until the next op in that group, no worse).
	 */
	publishedGroupEpochs?: Record<string, string>;
	/**
	 * Dev-mode tip transition log (newest first, capped at 20). One entry per
	 * tip move that actually changed ≥1 address — recorded in `setLastSeenTip`,
	 * the single chokepoint both read and write paths route through. Pure
	 * visibility; never read by sync logic.
	 */
	tipHistory?: TipTransition[];
	/**
	 * Own soft-delete tombstones awaiting their first publish (§10.5). Queued by
	 * `softDeleteGroup`, merged into {@link carriedTombstones} + cleared once
	 * published. The first-publish-only lifecycle keeps the queue bounded: a
	 * tombstone's durability after that is {@link carriedTombstones}'s job.
	 *
	 * INVARIANT: appended ONLY inside `softDeleteGroup`'s `runSerialized` op (which
	 * always publishes `resealMeta: true`). This guarantees a group-only publish
	 * (`resealMeta: false`) never observes a non-empty set — which is what keeps
	 * `buildInventory`'s tombstone filter from dropping a gid from the tip BEFORE
	 * the meta document carries its tombstone (which would make siblings resurrect
	 * it via the read-path `missingFromTip` diff). Any future writer MUST append +
	 * publish-meta atomically on the serialized lane.
	 */
	pendingTombstones?: Tombstone[];
	/**
	 * Tombstones carried forward across publishes (§10.5): own tombstones that
	 * have been published + peer tombstones adopted on reconcile, deduped per gid
	 * at the highest epoch. Set to the just-published `removed` union after every
	 * meta publish and unioned with the meta doc's `removed` on every read. This
	 * is what makes a deletion stick across the fleet: without it, a meta-only
	 * republish whose tip meta address is unchanged (e.g. a last-resort change
	 * after adopting a peer tombstone) would drop the peer's tombstone from the
	 * union. Resurrected gids are pruned at publish (composeTombstoneUnion XOR).
	 */
	carriedTombstones?: Tombstone[];
	/**
	 * Superseded document addresses awaiting Blossom deletion (spec §12 GC),
	 * drained at the start of the next publish. Carries the previous meta address
	 * after a meta re-seal, surviving a one-publish grace window for in-flight
	 * peer fetches before reaping. Best-effort hygiene; never blocks the push.
	 */
	pendingReap?: string[];
	/**
	 * Content hash of the meta view the device believes is currently on the tip
	 * (`metaViewHash` of `lastResortKeyPackage` + the composed `removed` set),
	 * recorded both when the device PUBLISHES a meta and when it ADOPTS a peer's.
	 * The read path recomputes the local hash on every tip read and compares — a
	 * mismatch means local meta state diverged from what's on the tip (an extra
	 * carried tombstone the tip lacks, or a different lastResort) and a
	 * `resealMeta` republish is scheduled. Recording it on adopt (not just
	 * publish) is what stops a freshly-linked device, or one adopting a peer's
	 * tombstone, from republishing byte-identical content: once the tip carries
	 * it, every device's local view matches and the diff is a no-op. Undefined
	 * only pre-first-tip-read (a brand-new link) — the first adopt/publish sets it.
	 */
	lastPublishedMetaHash?: string;
}

interface MultiDeviceConfigStore {
	[ownerPubkey: string]: MultiDeviceOwnerConfig;
}

function readAllConfigs(): MultiDeviceConfigStore {
	if (!browser) return {};
	try {
		return JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) ?? '{}') as MultiDeviceConfigStore;
	} catch {
		return {};
	}
}

function writeAllConfigs(configs: MultiDeviceConfigStore): void {
	if (!browser) return;
	localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(configs));
}

export function getMultiDeviceConfig(ownerPubkey?: string): MultiDeviceOwnerConfig | undefined {
	if (!browser) return undefined;
	const owner = ownerPubkey ?? manager.getActive()?.pubkey;
	if (!owner) return undefined;
	const config = readAllConfigs()[normalizePubKey(owner)];
	// Backfill `ownerPubkey` on configs created before the field existed (pre-
	// release dev state) so `saveConfig` never silently bails on them. The object
	// is a fresh JSON.parse, so mutating it is safe; the next save persists it.
	if (config && !config.ownerPubkey) config.ownerPubkey = normalizePubKey(owner);
	return config;
}

/** Whether multi-device sync is on for the active (or given) owner. */
export function isMultiDeviceActive(ownerPubkey?: string): boolean {
	return !!getMultiDeviceConfig(ownerPubkey);
}

function saveConfig(config: MultiDeviceOwnerConfig): void {
	if (!browser) return;
	// Write to the config's OWN owner (captured at creation), NOT the currently-
	// active account. A publish / reconcile spans multiple awaits (relay fetch +
	// Blossom uploads); if the user switched accounts mid-flight, writing to the
	// active account would land this config in the wrong slot — leaking the
	// ephemeral write key + DEK across identities and corrupting the other
	// account's config. `ownerPubkey` is always set at creation + backfilled on
	// read, so this is the account that owns the in-flight operation.
	if (!config.ownerPubkey) return;
	const all = readAllConfigs();
	all[normalizePubKey(config.ownerPubkey)] = config;
	writeAllConfigs(all);
	dbg('saveConfig', {
		owner: config.ownerPubkey.slice(0, 8),
		dTag: config.dTag.slice(0, 8)
	});
}

/** Random opaque `d`, generated once per identity (spec §6). */
function generateDTag(): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Build a fresh config (new ephemeral key + `d`), inheriting default relays. */
function createFreshConfig(
	ownerPubkey: string,
	relays: string[] = DEFAULT_MULTI_DEVICE_RELAYS,
	blossomServers: string[] = DEFAULT_BLOSSOM_SERVERS
): MultiDeviceOwnerConfig {
	const sk = generateSecretKey();
	const ephemeralPrivateKey = bytesToHex(sk);
	const ephemeralPubkey = getPublicKey(sk);
	return {
		ownerPubkey: normalizePubKey(ownerPubkey),
		dTag: generateDTag(),
		ephemeralPrivateKey,
		ephemeralPubkey,
		// Spec §7: a fresh Nostr keypair per identity, reused across every publish.
		// Independent of the ephemeral signing key (§7 requirement) so a connection-
		// string leak stays denial-of-service only (the DEK lives behind the
		// owner-NIP-44 seal in the tip, not behind the ephemeral key).
		dekPrivateKey: bytesToHex(generateSecretKey()),
		relays,
		blossomServers,
		pendingReap: []
	};
}

/**
 * Enable multi-device for the active owner, generating a fresh config if none
 * exists. Returns the (now-active) config so the UI can render the connection
 * string. Throws if no active account or the signer can't NIP-44 seal.
 */
export function enableMultiDevice(
	relays?: string[],
	blossomServers?: string[]
): MultiDeviceOwnerConfig {
	if (!browser) throw new Error('Multi-device can only run in the browser');
	const account = manager.getActive();
	if (!account) throw new Error('Log in to enable multi-device sync');
	// The tip seal routes through the active signer in BOTH directions (§6), so a
	// signer without NIP-44 v2 can neither read nor publish the tip. Fail at the
	// entry point instead of degrading to a silent zero-group state.
	if (!account.nip44) {
		throw new Error('This signer does not support NIP-44 v2 — multi-device sync needs it');
	}
	dbg('enableMultiDevice enter', { hadAccount: !!account, relayCount: relays?.length ?? 0 });
	const existing = getMultiDeviceConfig(account.pubkey);
	const config = existing ?? createFreshConfig(account.pubkey, relays, blossomServers);
	if (relays && relays.length) config.relays = relays;
	if (blossomServers && blossomServers.length) config.blossomServers = blossomServers;
	saveConfig(config);
	dbg('enableMultiDevice done', { dTag: config.dTag.slice(0, 8) });
	// Spec §11: the connection string is only usable once documents + a tip exist.
	// Publish every local group document + the meta document + the tip in one shot
	// so the string is live (the hooks otherwise only fire on individual
	// group/meta changes, not on enable itself).
	scheduleRepublish({ resealGroups: 'all', resealMeta: true });
	// Open the live tip subscription + adopt any peer state: a mid-session
	// enable is not cold start (so §10.6 ordering doesn't strictly apply), but we
	// still reconcile once so the enabling device catches up to siblings, and the
	// idempotent starter opens the subscription for ongoing convergence.
	void awaitMultiDeviceReconciled();
	return config;
}

/**
 * Clear the multi-device config for an owner (used by "log out and clean
 * data"). The tip subscription is torn down by the account-change path after
 * `manager.clearActive()`; this only removes the persisted config entry so the
 * next login starts clean. No-op without a browser / owner.
 */
export function clearMultiDeviceConfig(ownerPubkey: string): void {
	if (!browser) return;
	const all = readAllConfigs();
	delete all[normalizePubKey(ownerPubkey)];
	writeAllConfigs(all);
}

/**
 * Unlink this device: clear its config and stop being a sync peer. Local groups
 * remain as last-synced; re-link anytime via a connection string. Unlike
 * rotation, this does NOT reap the shared documents — other devices keep
 * syncing off the existing tip. A device is either linked (syncing) or
 * unlinked (not), never a half-state.
 */
export function unlinkMultiDevice(): void {
	dbg('unlinkMultiDevice enter');
	const owner = manager.getActive()?.pubkey;
	if (!owner) return;
	clearMultiDeviceConfig(owner);
	resetMultiDeviceSession();
}

/** Rotate the ephemeral keypair + `d` together (spec §11). All devices must re-link. */
export async function rotateMultiDeviceKey(
	relays?: string[],
	blossomServers?: string[]
): Promise<MultiDeviceOwnerConfig> {
	if (!browser) throw new Error('Multi-device can only run in the browser');
	const account = manager.getActive();
	if (!account) throw new Error('Log in to rotate the multi-device key');
	const existing = getMultiDeviceConfig(account.pubkey);
	// §12 GC: best-effort reap of every reachable document with the OLD key BEFORE
	// discarding it. Once `saveConfig(fresh)` runs the old ephemeral key is gone
	// and its blobs are permanently undeletable, so this is the last chance.
	// Bounded by a timeout so a hung server can't block rotation; the background
	// reap keeps running (the old key lives on in the closure) and completes if
	// it can. Pre-§12 historical orphans stay stranded either way.
	if (existing) {
		await Promise.race([
			reapAllReachable(existing).catch((error) => dbg('rotate reap failed', error)),
			new Promise<void>((resolve) => setTimeout(resolve, 15_000))
		]);
	}
	const fresh = createFreshConfig(
		account.pubkey,
		relays ?? existing?.relays,
		blossomServers ?? existing?.blossomServers
	);
	saveConfig(fresh);
	// Spec §11: rotation = mint a fresh ephemeral keypair + `d`, publish a new
	// tip, re-share. Without this republish the new (pubkey, d) has no tip event
	// until an unrelated trigger fires — leaving devices linked with the new
	// string looking at an empty tip while the old blobs have just been reaped.
	scheduleRepublish({ resealGroups: 'all', resealMeta: true });
	return fresh;
}

/** Update the editable relay set (inherits to newly-minted connection strings). */
export function setMultiDeviceRelays(relays: string[]): void {
	const config = getMultiDeviceConfig();
	if (!config) throw new Error('Enable multi-device before setting relays');
	config.relays = relays;
	saveConfig(config);
}

/** Set the document host list (ordered, most-reliable first). At least one required. */
export function setMultiDeviceBlossomServers(servers: string[]): void {
	const config = getMultiDeviceConfig();
	if (!config) throw new Error('Enable multi-device before setting the Blossom servers');
	// ponytail: preserve priority order; dedupe via array scan (the host list is
	// tiny, O(n²) is irrelevant) to keep plain logic free of svelte/reactivity.
	// Caller (UI) is expected to pass ≥1 — clamp to the default rather than store
	// an empty list.
	const seen: string[] = [];
	const normalized = servers
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => (seen.includes(s) ? false : (seen.push(s), true)));
	config.blossomServers = normalized.length ? normalized : DEFAULT_BLOSSOM_SERVERS;
	saveConfig(config);
	// The document addresses are stable (content-addressed), so a server change
	// only needs the tip re-published with the new server list — but republishing
	// also re-uploads to the new primary, guaranteeing it's reachable. Cheap; just
	// do it. Full re-publish (every group doc + meta) re-uploads them all.
	void scheduleRepublish({ resealGroups: 'all', resealMeta: true });
}

// ---------------------------------------------------------------------------
// NIP-44 seal + Blossom store adapters
// ---------------------------------------------------------------------------

/**
 * Return the active account's `nip44` capability as the tip seal. `ISigner["nip44"]`
 * already conforms to `Nip44Seal`, so no wrapping is needed. Returns undefined if
 * there is no active account or the signer doesn't expose nip44 (some signers
 * can't). Used for BOTH directions of the tip seal, which is an owner self-seal
 * (owner is sender AND recipient, spec §6) — so publish (encrypt) and read
 * (decrypt) both route through the signer's nip44. Document seals use the DEK
 * (getDekSeal), which stays local.
 */
function getActiveNip44Seal(): { seal: Nip44Seal; ownerPubkey: string } | undefined {
	const account = manager.getActive();
	if (!account) {
		dbg('getActiveNip44Seal skip', { reason: 'no active account' });
		return undefined;
	}
	if (!account.nip44) {
		dbg('getActiveNip44Seal skip', { reason: 'signer has no nip44', accountType: account.type });
		return undefined;
	}
	return { ownerPubkey: normalizePubKey(account.pubkey), seal: account.nip44 };
}

/**
 * Build the per-identity document encryption key (DEK) self-seal (spec §7). The
 * DEK is a local Nostr keypair (we hold the private key), so the seal is a
 * local NIP-44 self-seal — NOT the account signer. This is the whole point of
 * the DEK: document decrypts are local, avoiding a remote-signer round trip per
 * document (crippling on NIP-46 over poor connectivity). Returns undefined when
 * the device has not yet learned the DEK (a linked device before its first tip
 * read); the document paths then bail.
 */
function getDekSeal(
	config: MultiDeviceOwnerConfig
): { seal: Nip44Seal; dekPubkey: string } | undefined {
	if (!config.dekPrivateKey) {
		dbg('getDekSeal skip', { reason: 'no DEK learned yet' });
		return undefined;
	}
	const dekPriv = hexToBytes(config.dekPrivateKey);
	const dekPubkey = getPublicKey(dekPriv);
	// Self-seal: sender = recipient = the DEK keypair, so one conversation key
	// both encrypts and decrypts (symmetric). Precomputed once per config.
	const conversationKey = nip44.v2.utils.getConversationKey(dekPriv, dekPubkey);
	return {
		dekPubkey,
		seal: {
			// pubkey arg is the DEK's own (self-seal); the conversation key is fixed.
			encrypt: async (_pubkey, plaintext) => nip44.v2.encrypt(plaintext, conversationKey),
			decrypt: async (_pubkey, ciphertext) => nip44.v2.decrypt(ciphertext, conversationKey)
		}
	};
}

/** Blossom store for sealed documents (spec §12), ephemeral-signed. */
function makeBlossomStore(signer: BlossomSigner): BlobStore {
	return {
		async publish(blob) {
			// Replicate to every configured host so the read path's failover has
			// real fallbacks (the config UI promises "uploaded to all selected
			// hosts"). Parallel + best-effort: a non-primary failure is logged,
			// not fatal — fail only if EVERY host failed. The content address
			// (sha256(blob)) is deterministic, so every successful upload returns
			// the same address regardless of which server wins the race.
			const config = getMultiDeviceConfig();
			const servers = config?.blossomServers ?? BLOSSOM_SERVERS;
			const results = await Promise.allSettled(
				servers.map((server) => uploadBlob({ serverUrl: server, blob, signer }))
			);
			const firstOk = results.find(
				(r): r is PromiseFulfilledResult<UploadedBlob> => r.status === 'fulfilled'
			);
			if (!firstOk) {
				const failed = results.find((r) => r.status === 'rejected');
				const reason = failed?.status === 'rejected' ? failed.reason : undefined;
				throw reason instanceof Error
					? new Error(`All Blossom servers failed: ${reason.message}`)
					: new Error('All Blossom servers failed');
			}
			results.forEach((r, i) => {
				if (r.status === 'rejected') {
					dbg('blossom replication failed', {
						server: servers[i],
						error: (r.reason as Error)?.message
					});
				}
			});
			dbg('blossom upload ok', {
				ok: results.filter((r) => r.status === 'fulfilled').length,
				of: servers.length,
				sha256: firstOk.value.sha256.slice(0, 12),
				bytes: blob.byteLength
			});
			return { address: firstOk.value.sha256, url: firstOk.value.url };
		},
		async fetch(url) {
			return fetchBlob(url);
		}
	};
}

/**
 * Best-effort Blossom deletion of superseded/orphaned document addresses
 * (spec §12 GC). Fans `DELETE /<sha256>` (BUD-12) across every host the blobs
 * were replicated to: `404` is success (idempotent), `402`/`403`/unreachable
 * are logged and skipped. GC is hygiene, never a correctness path, so it never
 * throws. Delete auth is signed by the persisted owner signer (the uploading
 * pubkey), preserving the unlinkability of the ephemeral identity.
 */
async function reapAddresses(
	addresses: string[],
	servers: string[],
	signer: BlossomSigner
): Promise<void> {
	const targets = [...new Set(addresses.filter(Boolean))];
	if (targets.length === 0) return;
	const clean = [...new Set(servers.map((s) => s.replace(/\/+$/, '')))].filter(Boolean);
	const results = await Promise.allSettled(
		targets.flatMap((address) =>
			clean.map((server) => deleteBlob({ serverUrl: server, sha256Hex: address, signer }))
		)
	);
	dbg('reap addresses', {
		addresses: targets.length,
		servers: clean.length,
		ok: results.filter((r) => r.status === 'fulfilled' && r.value.ok).length,
		total: results.length
	});
}

/**
 * Delete a tombstoned group's whole `prev` chain (spec §12 GC). A soft-deleted
 * group is unreachable from the new tip and serves no catch-up purpose — behind
 * devices fast-forward from a snapshot (§8.5). Reuses the catch-up walker with
 * `localEpoch: -1n` to enumerate every epoch (all real epochs ≥ 0 > −1), then
 * fans out deletes. Fire-and-forget from `publish`; a missing link or hung
 * server just leaves that blob stranded.
 */
async function reapGroupChain(params: {
	headAddress: string;
	gid: string;
	pointer: TipPointer;
	dekSeal: Nip44Seal;
	dekPubkey: string;
	config: MultiDeviceOwnerConfig;
}): Promise<void> {
	let chain: ChainStep[] = [];
	try {
		chain = await walkGroupChain({
			tipAddress: params.headAddress,
			groupId: params.gid,
			localEpoch: -1n,
			store: makeReadStore(readServers(params.pointer, params.config)),
			addressToUrl: (a) => urlFromTip(a, params.pointer),
			seal: params.dekSeal,
			dekPubkey: params.dekPubkey
		});
	} catch (error) {
		dbg('reap chain walk failed (best-effort)', {
			gid: params.gid.slice(0, 8),
			error: errorMessage(error)
		});
	}
	// Head unioned explicitly: covers the epoch-0 doc and the throw-before-any-step case.
	await reapAddresses(
		[params.headAddress, ...chain.map((s) => s.address)],
		params.config.blossomServers,
		ephemeralSigner(params.config)
	);
}

/**
 * Delete every document reachable from a config's last-seen tip — each live
 * group's full chain plus the current meta and any pending-reap addresses —
 * using that config's ephemeral key. Used by `rotateMultiDeviceKey` as a
 * best-effort full cleanup BEFORE the key is discarded (after which its blobs
 * are permanently undeletable). Needs the DEK to decrypt the chain for walking.
 * Pre-§12 historical orphans (unreachable + unrecorded) stay stranded — those
 * are unrecoverable without the optional BUD-12 `/list`.
 */
async function reapAllReachable(config: MultiDeviceOwnerConfig): Promise<void> {
	const tip = config.lastSeenTip;
	if (!tip) return;
	const dek = getDekSeal(config);
	if (!dek) return;
	const pointer: TipPointer = {
		groups: tip.groups,
		metaAddress: tip.metaAddress,
		servers: config.blossomServers
	};
	const targets: string[] = [];
	if (tip.metaAddress) targets.push(tip.metaAddress);
	for (const g of tip.groups) {
		try {
			const chain = await walkGroupChain({
				tipAddress: g.address,
				groupId: g.gid,
				localEpoch: -1n,
				store: makeReadStore(readServers(pointer, config)),
				addressToUrl: (a) => urlFromTip(a, pointer),
				seal: dek.seal,
				dekPubkey: dek.dekPubkey
			});
			targets.push(g.address, ...chain.map((s) => s.address));
		} catch (error) {
			targets.push(g.address); // head is known + leaving the tip — delete it anyway
			dbg('reap-all chain walk failed (best-effort)', {
				gid: g.gid.slice(0, 8),
				error: errorMessage(error)
			});
		}
	}
	targets.push(...(config.pendingReap ?? []));
	await reapAddresses(targets, config.blossomServers, ephemeralSigner(config));
}

// ---------------------------------------------------------------------------
// Tip transport (spec §6)
// ---------------------------------------------------------------------------

/** Build the owner-signed inner event listing the document inventory (spec §6). */
async function buildInnerTipEvent(params: {
	pointer: TipPointer;
	ownerPubkey: string;
	/** Per-identity DEK private key (spec §6 `dek` tag, §7). */
	dekPrivateKey: string;
}): Promise<NostrEvent> {
	const template = {
		kind: MULTI_DEVICE_INNER_KIND,
		pubkey: params.ownerPubkey,
		content: '',
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			...params.pointer.groups.map((g) => ['x', g.address, 'group', g.gid] as string[]),
			...(params.pointer.metaAddress
				? [['x', params.pointer.metaAddress, 'meta'] as string[]]
				: []),
			// Spec §6 `dek` tag: the DEK private key travels inside the owner-NIP-44
			// seal so a linked device obtains it from one tip decrypt, then decrypts
			// every document locally (no per-doc signer round trip, §7).
			['dek', params.dekPrivateKey] as string[],
			...params.pointer.servers.map((s) => ['server', s] as string[])
		]
	};
	const account = manager.getActive();
	if (!account) throw new Error('No active account to sign the tip');
	// Inner event MUST be owner-signed (spec §6) — that is the authenticity
	// guarantee for the documents, since the seal is confidentiality-only.
	return account.signer.signEvent(template);
}

/** Build the sealed, ephemeral-signed outer replaceable event. */
function buildOuterTipEvent(params: {
	innerEvent: NostrEvent;
	sealedContent: string;
	ephemeralPrivateKey: string;
	ephemeralPubkey: string;
	dTag: string;
}): NostrEvent {
	const template = {
		kind: MULTI_DEVICE_TIP_KIND,
		pubkey: params.ephemeralPubkey,
		content: params.sealedContent,
		created_at: Math.floor(Date.now() / 1000),
		tags: [['d', params.dTag]]
	};
	// finalizeEvent mutates + returns its input; the ephemeral key authorizes
	// the replaceable event on the relay (spec §6), the inner signature is the
	// authenticity guarantee.
	return finalizeEvent(template, hexToBytes(params.ephemeralPrivateKey));
}

/** Parsed tip: the document inventory plus the DEK private key (spec §6). */
interface ParsedTip {
	pointer: TipPointer;
	/** DEK private key from the inner `dek` tag (absent on legacy pre-DEK tips). */
	dekPrivateKey?: string;
}

/** Parse + verify an outer tip event into the document inventory + DEK it carries. */
async function parseTipEvent(outer: NostrEvent, ownerPubkey: string): Promise<ParsedTip | null> {
	if (outer.kind !== MULTI_DEVICE_TIP_KIND) return null;
	const { seal } = getActiveNip44Seal() ?? {};
	if (!seal) return null;
	// Owner self-seal (spec §6): the seal sender is the owner npub (NOT the outer
	// event's ephemeral author — that only authorizes the replaceable event on the
	// relay). Decrypt uses the owner npub as sender, owner nsec (via the signer)
	// as recipient.
	let innerJson: string;
	try {
		innerJson = await seal.decrypt(ownerPubkey, outer.content);
	} catch {
		return null;
	}
	let inner: NostrEvent;
	try {
		inner = JSON.parse(innerJson) as NostrEvent;
	} catch {
		return null;
	}
	// The inner event MUST be owner-signed (spec §6 authenticity guarantee).
	if (!verifyEvent(inner) || inner.pubkey !== ownerPubkey) return null;
	const groups: TipGroupPointer[] = [];
	let metaAddress: string | undefined;
	let dekPrivateKey: string | undefined;
	for (const tag of inner.tags) {
		if (tag[0] === 'x') {
			if (tag[2] === 'group' && typeof tag[1] === 'string' && typeof tag[3] === 'string') {
				groups.push({ address: tag[1], gid: tag[3] });
			} else if (tag[2] === 'meta' && typeof tag[1] === 'string') {
				metaAddress = tag[1];
			}
		} else if (tag[0] === 'dek' && typeof tag[1] === 'string') {
			// Spec §6 `dek` tag: 64 hex chars of the DEK private key (§7).
			dekPrivateKey = tag[1];
		}
	}
	const servers = inner.tags
		.filter((t) => t[0] === 'server')
		.map((t) => t[1])
		.filter((s): s is string => typeof s === 'string');
	if (groups.length === 0 && metaAddress === undefined) return null;
	return { pointer: { groups, metaAddress, servers }, dekPrivateKey };
}

/** Pick the first advertised server for an address (spec §6 fetch order). */
function urlFromTip(address: string, pointer: TipPointer): string {
	return `${pointer.servers[0]?.replace(/\/+$/, '') ?? ''}/${address}`;
}

/** Build (and seal) the outer tip event for the current inventory (spec §6). */
async function buildTipEvent(
	pointer: TipPointer,
	config: MultiDeviceOwnerConfig
): Promise<NostrEvent> {
	const account = manager.getActive();
	if (!account) throw new Error('No active account');
	const ownerPubkey = normalizePubKey(account.pubkey);
	if (!config.dekPrivateKey) throw new Error('Cannot publish tip: no DEK configured');
	const inner = await buildInnerTipEvent({
		pointer,
		ownerPubkey,
		dekPrivateKey: config.dekPrivateKey
	});
	dbg('tip inner owner-signed', {
		groups: pointer.groups.length,
		meta: !!pointer.metaAddress
	});
	// Owner self-seal (spec §6): NIP-44 v2 with the owner as BOTH sender and
	// recipient — getConversationKey(owner_nsec, owner_npub), via the signer. This
	// is the only seal sender that keeps the DEK (carried in the inner `dek` tag,
	// §7) behind the owner key and out of reach of a connection-string leak
	// (§11, §13): NIP-44's conversation key is symmetric ECDH, so any holder of
	// the SENDER's private half derives it too, and the ephemeral private key
	// travels in the connection string — it MUST NOT be the seal sender. Costs one
	// signer nip44 round trip on the publish path, which §10.5 makes non-blocking.
	const { seal } = getActiveNip44Seal() ?? {};
	if (!seal) throw new Error('Cannot publish tip: signer has no nip44');
	const sealedContent = await seal.encrypt(ownerPubkey, JSON.stringify(inner));
	return buildOuterTipEvent({
		innerEvent: inner,
		sealedContent,
		ephemeralPrivateKey: config.ephemeralPrivateKey,
		ephemeralPubkey: config.ephemeralPubkey,
		dTag: config.dTag
	});
}

/** Publish a built tip event to the config relays (spec §6). */
async function publishOuterTip(outer: NostrEvent, relays: string[]): Promise<void> {
	const responses = await relayPool.publish(relays, outer);
	dbg('tip outer published', { relays, accepted: responses.length });
}

// ---------------------------------------------------------------------------
// Connection string (spec §11)
// ---------------------------------------------------------------------------

interface ConnectionPayload {
	/** naddr locating the outer replaceable tip event. */
	naddr: string;
	/** Ephemeral write key (hex). Carries NO owner key material. */
	ephemeralPrivateKey: string;
}

/**
 * Mint a connection string for the active owner's config. The string is the
 * connection payload, base64-encoded for QR/paste. Conveys locator + write
 * capability only (spec §11).
 */
export function buildConnectionString(config: MultiDeviceOwnerConfig): string {
	const naddr = nip19.naddrEncode({
		kind: MULTI_DEVICE_TIP_KIND,
		pubkey: config.ephemeralPubkey,
		identifier: config.dTag,
		relays: config.relays
	});
	const payload: ConnectionPayload = { naddr, ephemeralPrivateKey: config.ephemeralPrivateKey };
	return btoa(JSON.stringify(payload));
}

/** Parse a pasted/scanned connection string. Throws on malformed input. */
function parseConnectionString(connection: string): ConnectionPayload {
	const json = JSON.parse(atob(connection)) as Partial<ConnectionPayload>;
	if (!json.naddr || !json.ephemeralPrivateKey) {
		throw new Error('Connection string is missing the naddr or ephemeral key');
	}
	// Validate the naddr decodes and points at the tip kind.
	const decoded = nip19.decode(json.naddr);
	if (decoded.type !== 'naddr' || decoded.data.kind !== MULTI_DEVICE_TIP_KIND) {
		throw new Error('Connection string naddr does not point at a multi-device tip');
	}
	return { naddr: json.naddr, ephemeralPrivateKey: json.ephemeralPrivateKey };
}

// ---------------------------------------------------------------------------
// Re-publish hook (spec §10)
// ---------------------------------------------------------------------------

// `publishInFlight` serializes WRITES only. The read path (`handleTipEvent` →
// `applyTip`) is deliberately off this lane so a slow push can't stall group
// seeding/fast-forwarding. Consequence: a read reconcile and a write publish can
// interleave. This is benign by construction: per-group writes are CAS-locked
// (`runGroupOperation`), the relay event is replaceable, and the read-path
// divergence diff schedules its push through `scheduleRepublish` → this lane,
// so the two pushes can't run concurrently — only a read's reconcile can overlap
// a push. Worst case is one redundant publish cycle (a stale `lastSeenTip` write
// that the next `fetchTipForPublish` / sub delivery corrects). Not corruption.
let publishInFlight: Promise<void> = Promise.resolve();

/**
 * Run an operation on the shared serialized publish lane. The tip is a single
 * replaceable event, so read-modify-write republishes MUST serialize. Used
 * directly by paths needing an atomic side effect before publish
 * (`softDeleteGroup` appends a tombstone inside the lane so a concurrent publish
 * can't clear it). Fire-and-forget; errors are logged, not thrown.
 */
function runSerialized(operation: () => Promise<void>): void {
	publishInFlight = publishInFlight
		.catch(() => {})
		.then(() => operation())
		.catch((error) => {
			console.warn('[multi-device] re-publish failed', error);
		});
}

/** Union two publish plans: gids merge (any `'all'` wins), meta ORs. */
function mergePlans(a: PublishPlan, b: PublishPlan): PublishPlan {
	const groups =
		a.resealGroups === 'all' || b.resealGroups === 'all'
			? 'all'
			: [...new Set([...a.resealGroups, ...b.resealGroups])];
	return { resealGroups: groups, resealMeta: a.resealMeta || b.resealMeta };
}

let pendingPlan: PublishPlan | null = null;
let flushScheduled = false;

/**
 * Queue a plan-only republish, merged with any plan queued in the same tick.
 * Hooks that fire back-to-back (e.g. two `onMetaStateChange` during enable)
 * coalesce into ONE publish — one tip fetch, one upload round, one tip publish —
 * instead of N serialized ones. Flushes on the next microtask; `runSerialized`
 * still orders each flush after any in-flight publish.
 */
function scheduleRepublish(plan: PublishPlan): void {
	pendingPlan = pendingPlan ? mergePlans(pendingPlan, plan) : plan;
	if (flushScheduled) return;
	flushScheduled = true;
	queueMicrotask(() => {
		flushScheduled = false;
		const batch = pendingPlan;
		pendingPlan = null;
		if (batch) runSerialized(() => publish(batch));
	});
}

/**
 * Re-publish hook for a group change (spec §10): publish only that group's
 * document and update only its `group` `x` tag in the tip. Fire-and-forget;
 * a no-op when multi-device is disabled. Wired at three epoch-advancing sites:
 * group creation (`createChatGroup`), welcome acceptance (`acceptChatWelcome`),
 * and unconditionally at the end of `runOutboundGroupOperation` (the chokepoint
 * invite/remove/metadata route through). The read-path divergence diff
 * (`handleTipEvent`) is the backstop that catches any trigger this hook misses.
 */
export function onGroupStateAdvance(gid: string): void {
	if (!browser) return;
	const config = getMultiDeviceConfig();
	if (!config) return;
	dbg('onGroupStateAdvance', { gid: gid.slice(0, 8), dTag: config.dTag.slice(0, 8) });
	scheduleRepublish({ resealGroups: [gid], resealMeta: false });
}

/**
 * Re-publish hook for an identity-level change (spec §10.5): a last-resort
 * key-package publish/rotate. Publishes only the meta document and updates
 * only its `meta` `x` tag. Fire-and-forget. (Soft-delete tombstones publish
 * directly via `softDeleteGroup`'s serialized op — atomically with the
 * tombstone append — so they don't route through this hook.)
 */
export function onMetaStateChange(): void {
	if (!browser) return;
	const config = getMultiDeviceConfig();
	if (!config) return;
	dbg('onMetaStateChange', { dTag: config.dTag.slice(0, 8) });
	scheduleRepublish({ resealGroups: [], resealMeta: true });
}

/** An empty tip pointer (used when the fetched tip parses to nothing). */
function emptyTipPointer(config: MultiDeviceOwnerConfig): TipPointer {
	return { groups: [], servers: config.blossomServers };
}

/** Live groups' local epochs, decoded once per collection — the input side of
 *  the stale-epoch diff. Same decode cost class as
 *  `makeReconcileTarget.localEpoch`, which already runs per changed gid. */
function collectLocalGroupEpochs(
	groups: ReturnType<typeof collectActiveGroups>
): { gid: string; epoch: string }[] {
	return groups.map((group) => ({
		gid: group.id,
		epoch: decodeStoredGroupState(group).groupContext.epoch.toString()
	}));
}

/** Merge epochs known reflected by the tip (sealed or adopted) into the
 *  owed-push record, pruning gids no longer live. Caller persists: the read
 *  path's following `setLastSeenTip` saves; the write path saves after the
 *  tip rewrite lands. */
function mergePublishedGroupEpochs(
	config: MultiDeviceOwnerConfig,
	updates: Record<string, string>
): void {
	const next: Record<string, string> = { ...(config.publishedGroupEpochs ?? {}) };
	for (const [gid, epoch] of Object.entries(updates)) next[gid] = epoch;
	const live = new Set(collectActiveGroups().map((g) => g.id));
	for (const gid of Object.keys(next)) if (!live.has(gid)) delete next[gid];
	config.publishedGroupEpochs = next;
}

/** Ephemeral Blossom signer used by all republish paths. */
function ephemeralSigner(config: MultiDeviceOwnerConfig): BlossomSigner {
	return {
		async signEvent(template) {
			return finalizeEvent(template, hexToBytes(config.ephemeralPrivateKey));
		}
	};
}

/**
 * §10.5 reconcile-before-push head: fetch the current tip, parse it, and decide
 * whether to proceed. Returns the parsed pointer (possibly empty) and a
 * `deferred` flag for the offline-MUST — a tip that was reachable before (we
 * have seen one: `lastSeenTip` is set) but isn't now → defer the push. On a
 * first-ever publish (never seen a tip) the caller may push fresh.
 */
async function fetchTipForPublish(
	config: MultiDeviceOwnerConfig,
	ownerPubkey: string
): Promise<{ pointer: TipPointer; deferred: boolean }> {
	const tipEvent = await fetchLatestTipEvent(config);
	if (!tipEvent) {
		if (config.lastSeenTip) {
			dbg('republish deferred', { reason: 'tip unreachable; cannot reconcile before push' });
			return { pointer: emptyTipPointer(config), deferred: true };
		}
		return { pointer: emptyTipPointer(config), deferred: false };
	}
	// §10.5 reconcile-before-push: same outer event id ⇒ byte-identical tip ⇒ no
	// peer change since our last write/read. Reuse the local pointer and skip the
	// owner-signer decrypt. Mirrors handleTipEvent's dedup; falls through to decrypt
	// whenever a peer moved the tip (or the relay returned a stale event).
	if (tipEvent.id === config.lastSeenTipEventId && config.lastSeenTip) {
		dbg('republish tip unchanged', { eventId: tipEvent.id.slice(0, 12) });
		return { pointer: { ...config.lastSeenTip, servers: config.blossomServers }, deferred: false };
	}
	const parsed = await parseTipEvent(tipEvent, ownerPubkey);
	return { pointer: parsed?.pointer ?? emptyTipPointer(config), deferred: false };
}

/**
 * Diff two tip group inventories by gid (pure projection for the dev log).
 * Obviously-correct Set math; no test — visualization only, not a trust path.
 */
function diffTipGroups(
	prev: TipGroupPointer[],
	next: TipGroupPointer[]
): { added: TipGroupPointer[]; removed: TipGroupPointer[]; changed: TipGroupPointer[] } {
	const prevAddr = new Map(prev.map((g) => [g.gid, g.address]));
	const nextGids = new Set(next.map((g) => g.gid));
	const added: TipGroupPointer[] = [];
	const changed: TipGroupPointer[] = [];
	for (const g of next) {
		const old = prevAddr.get(g.gid);
		if (old === undefined) added.push(g);
		else if (old !== g.address) changed.push(g);
	}
	const removed = prev.filter((g) => !nextGids.has(g.gid));
	return { added, removed, changed };
}

/**
 * Record a seen tip + its event id (§6 per-doc delta + §10.5 self-echo dedup).
 * Also appends a `TipTransition` to the dev log when the tip actually moved —
 * same-address re-deliveries (relay replay, self-echo past the dedup) are noise.
 */
function setLastSeenTip(
	config: MultiDeviceOwnerConfig,
	pointer: TipPointer,
	eventId: string,
	meta: { source: 'read' | 'write'; counts?: ReconcileCounts }
): void {
	const prev = config.lastSeenTip;
	const diff = diffTipGroups(prev?.groups ?? [], pointer.groups);
	const metaChanged = pointer.metaAddress !== prev?.metaAddress;
	if (diff.added.length || diff.removed.length || diff.changed.length || metaChanged) {
		const entry: TipTransition = {
			at: Date.now(),
			eventId,
			source: meta.source,
			counts: meta.counts,
			added: diff.added,
			removed: diff.removed,
			changed: diff.changed,
			metaChanged,
			metaAddress: pointer.metaAddress
		};
		config.tipHistory = [entry, ...(config.tipHistory ?? [])].slice(0, 20);
	}
	config.lastSeenTip = { groups: pointer.groups, metaAddress: pointer.metaAddress };
	config.lastSeenTipEventId = eventId;
	saveConfig(config);
}

/** What a `publish()` call re-seals (spec §10.5 publishing unit). */
type PublishPlan = {
	/** Gids to re-seal + re-upload, or `'all'` for every active local group. */
	resealGroups: string[] | 'all';
	/** Re-seal + re-upload the meta document (tombstones + last-resort key package). */
	resealMeta: boolean;
};

/**
 * Ingestion chokepoint (§6 + §8): reconcile only documents whose address
 * changed vs `lastSeenTip`. Shared by the read path (`handleTipEvent`) and the
 * write path (`publish`). Does NOT write `lastSeenTip` — the caller records it.
 */
// Max groups reconciled in parallel during a tip apply. Each group's
// `pullAndReconcileGroup` races M Blossom servers via `makeReadStore`, so this
// bounds the concurrent fetch burst (groups × servers) on a cold link and the
// peak memory (each slot holds decrypted per-epoch states + the fetched gap
// during replay). 8 covers a typical fleet ENTIRELY — with the old 5, a slow
// coordinator's groups could occupy every slot and head-of-line block the
// fast ones (in tip order); 8 makes "one slow coordinator" cost only its own
// groups. It stops short of unbounded: extra concurrency doesn't reduce total
// bytes on a saturated (slow-internet) link, it inflates per-item latency and
// starves the small coordinator RTTs behind blob transfers.
const MD_GROUP_RECONCILE_CONCURRENCY = 8;

/** Minimal order-preserving concurrency-limited map. No dependency for a pool
 * this small. */
async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await fn(items[i]!, i);
			}
		})
	);
	return results;
}
async function applyTip(
	pointer: TipPointer,
	ctx: { dekSeal: Nip44Seal; dekPubkey: string; config: MultiDeviceOwnerConfig }
): Promise<{ counts: ReconcileCounts; localAheadGids: string[] }> {
	const { dekSeal, dekPubkey, config } = ctx;
	const lastSeen = config.lastSeenTip;
	const counts: ReconcileCounts = {
		seeded: 0,
		fastForwarded: 0,
		skipped: 0,
		dropped: 0,
		ignored: 0
	};
	// gids whose fetched document was at a local epoch ≥ incoming (the §8 'skipped'
	// outcome). Collected for the read-path divergence diff (§8/§10.5 "local
	// ahead of tip") — the write path (publish's reconcile-before-push) ignores it.
	const localAheadGids: string[] = [];
	// Epochs adopted from the tip this pass (seed / fast-forward): recording them
	// marks local state as reflected-by-the-tip WITHOUT a push, keeping the
	// stale-epoch diff quiet for adopted (converged) groups. Skips are
	// deliberately absent — a skip is the owed-push signal itself. Caller's
	// setLastSeenTip persists this alongside the new tip addresses.
	const adoptionEpochs: Record<string, string> = {};

	// Reconcile changed groups in parallel — each gid writes its own storage key +
	// MLS state, and fastForwardGroup runs under a per-group lock
	// (runGroupOperation), so the groups are independent. counts mutates only at
	// await boundaries (JS is single-threaded), so the increments can't race.
	let reconciled = 0;
	await mapPool(pointer.groups, MD_GROUP_RECONCILE_CONCURRENCY, async (group) => {
		try {
			const lastSeenGroup = lastSeen?.groups.find((g) => g.gid === group.gid);
			// §8 fetch liveness: an unchanged tip address is a no-op ONLY when healthy.
			// A gid whose fetch failed must keep retrying past backoff, and a tip that
			// moved past the failed address fetches immediately.
			if (
				!shouldReconcileGroupDocument({
					lastSeenAddress: lastSeenGroup?.address,
					tipAddress: group.address,
					unresolved: config.unresolvedDocumentPulls?.[group.gid],
					now: Date.now()
				})
			)
				return;
			dbg('applyTip group changed', { gid: group.gid, address: group.address.slice(0, 12) });
			try {
				const { doc, outcome } = await pullAndReconcileGroup(
					group,
					pointer,
					dekSeal,
					dekPubkey,
					config
				);
				// Fetch + apply succeeded → the gid is reconciled again.
				if (config.unresolvedDocumentPulls?.[group.gid]) {
					delete config.unresolvedDocumentPulls[group.gid];
					saveConfig(config);
				}
				if (outcome === 'seeded') counts.seeded++;
				else if (outcome === 'fast-forwarded') counts.fastForwarded++;
				else if (outcome === 'fork-resolved') {
					counts.forkResolved = (counts.forkResolved ?? 0) + 1;
				} else {
					counts.skipped++;
					// §8 skip ⟺ local epoch ≥ document epoch ⟺ local is ahead of the tip
					// for this gid. Record for the read-path divergence diff.
					localAheadGids.push(group.gid);
				}
				if (outcome !== 'skipped') {
					const epoch = groupEpoch(doc);
					if (epoch !== undefined) adoptionEpochs[group.gid] = epoch.toString();
				}
			} catch (error) {
				// §8 fetch liveness: a failed fetch is NOT reconciled. Record it so the
				// dedup gates keep retrying (beyond backoff) instead of stranding this
				// gid behind the fleet forever. Attempts reset when the tip moves.
				const previous = config.unresolvedDocumentPulls?.[group.gid];
				config.unresolvedDocumentPulls = {
					...(config.unresolvedDocumentPulls ?? {}),
					[group.gid]: {
						address: group.address,
						attempts: (previous?.address === group.address ? previous.attempts : 0) + 1,
						lastAttemptAt: Date.now()
					}
				};
				saveConfig(config);
				scheduleUnresolvedRetry();
				dbg('applyTip group reconcile failed', { gid: group.gid, error });
			}
		} finally {
			// Advance the per-group counter for an active user-initiated flow (link).
			// `finally` runs even on the early `return` above, so the bar always
			// reaches `total`. No-op when mdProgress is null (background cycles).
			bumpMdProgress(++reconciled);
		}
	});

	if (Object.keys(adoptionEpochs).length) {
		// Persisted by the caller's setLastSeenTip (both callers run it after
		// applyTip). Marks adopted state as tip-reflected so the stale-epoch diff
		// stays quiet for converged groups (no echo republish of peer content).
		mergePublishedGroupEpochs(config, adoptionEpochs);
	}

	if (pointer.metaAddress && pointer.metaAddress !== lastSeen?.metaAddress) {
		dbg('applyTip meta changed', { address: pointer.metaAddress.slice(0, 12) });
		try {
			const { doc, counts: metaCounts } = await pullAndReconcileMeta(
				pointer,
				dekSeal,
				dekPubkey,
				config
			);
			// §10.5 tombstone durability: union the peer's `removed` set into the
			// persistent carry-forward store so a later meta-only republish (whose tip
			// meta address is unchanged, so this block won't re-run) still publishes
			// them. The caller persists config via setLastSeenTip. An empty
			// `presentGids` keeps every peer tombstone here — the XOR against live
			// groups happens at publish (composeTombstoneUnion).
			config.carriedTombstones = composeTombstoneUnion(
				config.carriedTombstones ?? [],
				doc.removed ?? [],
				[]
			);
			counts.dropped += metaCounts.dropped;
			counts.ignored += metaCounts.ignored;
			// Record the tip's meta content as the convergence baseline so the read-path
			// diff (handleTipEvent) doesn't flag a just-adopted meta as "ahead". Without
			// this, a fresh link (hash undefined) or a tombstone adoption (carried
			// changed) would spuriously republish byte-identical content (new issuedAt /
			// seal address only) — once per device per adoption, pure network waste
			// since every device shares ONE tip that already carries the content. The
			// diff compares the LOCAL composed view to this; if local genuinely diverges
			// (an extra carried tombstone the tip lacks, a different lastResort), it
			// still fires correctly. Computed from the adopted doc, not the local view,
			// because this field means "what's on the tip", and we just put that there.
			config.lastPublishedMetaHash = metaViewHash({
				lastResortKeyPackage: doc.lastResortKeyPackage,
				removed: doc.removed
			});
			// §11.5 repair: converge the last-resort each coordinator serves with
			// the adopted entry (re-adopt theirs when held, else publish ours).
			// Fire-and-forget: coordinator IO bounded to known coordinators,
			// terminates on the next pass, fires only on meta tip moves.
			void repairLastResortAlignment();
		} catch (error) {
			dbg('applyTip meta reconcile failed', { error });
		}
	}

	return { counts, localAheadGids };
}

/**
 * The one §10.5 procedure: reconcile the full doc set, then publish only the
 * affected document(s) and rewrite the tip. `plan` picks what to re-seal
 * (group change → that group; meta change → meta; enable/server → all). §4.3
 * is enforced once in `buildInventory`.
 */
async function publish(plan: PublishPlan): Promise<void> {
	const config = getMultiDeviceConfig();
	if (!config) return;
	// The owner-NIP-44 capability gates the flow: publish decrypts the current
	// tip to reconcile (parseTipEvent, owner self-seal §6) and re-seals the new
	// tip via the same signer (buildTipEvent, owner self-seal §6). The DEK gates
	// document encrypt/decrypt (§7, local — no signer).
	const active = getActiveNip44Seal();
	if (!active) return;
	const { ownerPubkey } = active;
	const dek = getDekSeal(config);
	if (!dek) return;
	const { seal: dekSeal, dekPubkey } = dek;
	const { pointer, deferred } = await fetchTipForPublish(config, ownerPubkey);
	if (deferred) return;

	// §12 GC: drain addresses queued for deletion last publish (one-publish grace
	// window for in-flight peer fetches). Fire-and-forget — never block the push.
	const reapNow = config.pendingReap ?? [];
	if (reapNow.length) {
		config.pendingReap = [];
		void reapAddresses(reapNow, config.blossomServers, ephemeralSigner(config));
	}

	// §10.5 reconcile-before-push: full document set, delta-gated by lastSeenTip.
	const { counts } = await applyTip(pointer, { dekSeal, dekPubkey, config });
	const writeStore = makeBlossomStore(ephemeralSigner(config));

	// The published `removed` set (own pending + carried-forward, XOR'd vs the
	// live inventory per §4.3) drives both the meta doc and the tip's group
	// filter. `carriedTombstones` is the persistent store (own-published + peer-
	// adopted) so a deletion sticks across the fleet across publishes (§10.5).
	const liveGroups = collectActiveGroups();
	const removed = composeTombstoneUnion(
		config.pendingTombstones ?? [],
		config.carriedTombstones ?? [],
		liveGroups.map((g) => g.id)
	);
	const tombstonedGids = new Set(removed.map((t) => t.gid));

	// Re-seal the affected group documents (§10.5 publishing unit) in parallel.
	// The groups are independent — each reads its `prev` from the immutable
	// fetched tip, not from a sibling's result — so only the tip (published below)
	// needs every address. Promise.all preserves input order, so the tip's
	// `groups` array order is unchanged. The plan is UNIONED with the stale-epoch
	// gids (§10.5 owed-push record): any successful publish sweeps changes
	// stranded by an earlier deferred / failed / killed one, so a stranded group
	// heals on the next publish of ANY kind, not just its own next op. (Skips
	// from this pass's reconcile are NOT unioned — an equal-epoch advisory doc is
	// not a strand; that tip-stale case is the read path's diffLocalAhead job.)
	const staleGids = diffStaleGroupEpochs({
		localEpochs: collectLocalGroupEpochs(liveGroups),
		publishedEpochs: config.publishedGroupEpochs
	});
	const gidsToReseal =
		plan.resealGroups === 'all'
			? liveGroups.map((g) => g.id)
			: [...new Set([...plan.resealGroups, ...staleGids])];
	// Surface progress only for bulk reseals (enable / server change / rotation);
	// steady-state reseals a single changed group and would flicker a bar for
	// nothing. The DEK seal is local, so the Blossom upload round is the slow part.
	const trackProgress = gidsToReseal.length >= 2;
	if (trackProgress) setMdProgress('Preparing groups', 0, gidsToReseal.length);
	let resealDone = 0;
	const resealed: TipGroupPointer[] = [];
	const sealedEpochs: Record<string, string> = {};
	try {
		const results = await Promise.all(
			gidsToReseal.map(async (gid): Promise<TipGroupPointer | null> => {
				const group = liveGroups.find((g) => g.id === gid);
				if (!group) return null; // gone (tombstoned/deleted) since the trigger fired
				const snapshot = toGroupSnapshot(group);
				const prev = pointer.groups.find((g) => g.gid === gid)?.address;
				const result = await publishGroupDocument({
					group: snapshot,
					seal: dekSeal,
					dekPubkey,
					store: writeStore,
					prev,
					// Spec §8.5 gen-0 state / §10.3 rank: the epoch's commit-point
					// document is chained under the live one whenever the live state
					// has moved past the Commit.
					commitPoint: group.commitPoint
				});
				// Epoch AT SEAL TIME — if local advances again mid-publish, the record
				// stays honestly behind and the next diff flags it (that state IS owed).
				const epoch = decodeStoredGroupState(group).groupContext.epoch;
				sealedEpochs[gid] = epoch.toString();
				// Record the published document identity (spec §10) — a fork cannot be
				// ranked against our own publications otherwise. Re-read the record
				// first: the upload is concurrent with live ingestion, which may
				// have replaced it under us.
				const fresh = getChatGroup(gid);
				if (fresh) {
					replaceGroup(gid, {
						...fresh,
						appliedDocument: {
							address: result.address,
							cursor: result.cursor,
							fingerprint: stateFingerprint(decodeStoredGroupState(group))
						},
						// The commit point is on record: published as its own document, or
						// carried by the live one (spec §10.3).
						...(fresh.commitPoint &&
						fresh.commitPoint.epoch === epoch.toString() &&
						!fresh.commitPoint.published
							? { commitPoint: { ...fresh.commitPoint, published: true } }
							: {})
					});
				}
				bumpMdProgress(++resealDone);
				dbg('publish group doc', { gid, address: result.address.slice(0, 12) });
				return { address: result.address, gid };
			})
		);
		resealed.push(...results.filter((r): r is TipGroupPointer => r !== null));
	} finally {
		if (trackProgress) clearMdProgress();
	}

	// Re-seal the meta document (tombstones + last-resort key package) only when asked.
	let metaAddress = pointer.metaAddress;
	if (plan.resealMeta) {
		const result = await publishMetaDocument({
			seal: dekSeal,
			dekPubkey,
			store: writeStore,
			removed,
			lastResortKeyPackage: getLastResortKeyPackageEntry()
		});
		metaAddress = result.address;
		dbg('publish meta doc', { address: result.address.slice(0, 12), removed: removed.length });
	}

	// Rewrite the tip with the full inventory; §4.3 drops tombstoned gids.
	const groups = buildInventory(pointer, resealed, tombstonedGids);
	await finalizeTipPublish({ groups, metaAddress, servers: config.blossomServers }, config, counts);
	// Record sealed epochs ONLY now — after the tip rewrite landed on relays. A
	// crash between upload and tip-rewrite must leave the record stale so the
	// next heal republishes (the tip never moved). finalizeTipPublish already
	// persisted lastSeenTip; this is the one extra save for the owed-push record.
	if (Object.keys(sealedEpochs).length) {
		mergePublishedGroupEpochs(config, sealedEpochs);
		saveConfig(config);
	}

	// Tombstone carry-forward (§10.5): persist the just-published `removed` union
	// (own pending + carried, XOR'd vs live) as the new carry-forward store, then
	// clear pending. This is the fix for tombstone durability — without it, the
	// next meta-only republish (a last-resort change, a re-mark) would publish an
	// empty `removed` and silently un-tombstone the group fleet-wide. Resurrected
	// gids are already absent from `removed` (composeTombstoneUnion's XOR), so
	// assigning the pruned union keeps the store from growing unboundedly.
	// §12 GC: queue the superseded meta for deletion on the NEXT publish — a
	// one-publish grace window for in-flight peer fetches before the old blob is reaped.
	if (plan.resealMeta) {
		const next = planCarryForward({
			pendingTombstones: config.pendingTombstones ?? [],
			carriedTombstones: config.carriedTombstones ?? [],
			liveGids: liveGroups.map((g) => g.id),
			oldMetaAddress: pointer.metaAddress,
			newMetaAddress: metaAddress,
			pendingReap: config.pendingReap ?? []
		});
		config.carriedTombstones = next.carriedTombstones;
		config.pendingTombstones = next.pendingTombstones;
		config.pendingReap = next.pendingReap;
		// Record the content hash of the meta view we just pushed, so the read path's
		// divergence diff (handleTipEvent) can tell a subsequent read that the local
		// meta view matches the tip and needs no `resealMeta` push. Computed from
		// the same `removed` + last-resort entry the doc was sealed from.
		config.lastPublishedMetaHash = metaViewHash({
			lastResortKeyPackage: getLastResortKeyPackageEntry(),
			removed
		});
		saveConfig(config);
	}

	// §12 GC: a group leaving the tip this publish (tombstoned while still live
	// in the fetched tip) has its whole `prev` chain deleted — it is unreachable
	// from the new tip and behind devices fast-forward from a snapshot (§8.5).
	// Fire-and-forget; a missing link or hung server just leaves that blob.
	for (const gid of tombstonedGids) {
		const head = pointer.groups.find((g) => g.gid === gid)?.address;
		if (head) void reapGroupChain({ headAddress: head, gid, pointer, dekSeal, dekPubkey, config });
	}

	dbg('publish done', {
		reseal: gidsToReseal.length,
		meta: plan.resealMeta,
		groups: groups.length
	});
}

/**
 * Shared tail: publish the tip for `pointer` and persist the new addresses as
 * the last-seen tip (§6 per-doc delta + §10.5 offline-defer signal).
 */
async function finalizeTipPublish(
	pointer: TipPointer,
	config: MultiDeviceOwnerConfig,
	counts?: ReconcileCounts
): Promise<void> {
	const outer = await buildTipEvent(pointer, config);
	// Persist the new addresses + event id BEFORE the relay publish: the publish
	// loops the event back through our own subscription, and this ordering makes
	// that self-echo short-circuit in `handleTipEvent` (§10.5 tip-address check)
	// instead of re-fetching our own just-published documents.
	setLastSeenTip(config, pointer, outer.id, { source: 'write', counts });
	await publishOuterTip(outer, config.relays);
}

/** Active local groups, undecoded (spec §4 — the live inventory). `group.id` IS
 * the protocol gid (set at creation, immutable), so listing needs no MLS decode. */
function collectActiveGroups(): StoredChatGroup[] {
	return listChatGroups().filter((g) => !g.status || g.status === 'active');
}

/** Decode one group's MLS state into a publish snapshot. Called only for the
 * groups actually being re-sealed, so a single-group advance decodes 1, not N. */
function toGroupSnapshot(group: StoredChatGroup): GroupSnapshot {
	return {
		gid: group.id,
		state: decodeStoredGroupState(group),
		coordinatorKey: group.coordinatorKey,
		// Publish side of spec §4.1 `coordinatorRelays`: the writer's own saved
		// relay configuration only. Empty/absent = "no hint" — the adopting device
		// resolves through its own configuration or discovery, exactly as here.
		coordinatorRelays: getChatCoordinator(group.coordinatorKey)?.relays,
		fetchCursor: group.fetchCursor,
		lastCursor: group.lastCursor
	};
}

// ---------------------------------------------------------------------------
// Tip subscription + reconciliation (the linked-device read path)
// ---------------------------------------------------------------------------

let tipSubscription: { unsubscribe: () => void } | null = null;

// §10.6: one-shot cold-start reconcile promise. Holds while the tip is fetched
// + applied before the delivery stream opens; resolves immediately when MD is
// off. Reset on account change / disable via resetMultiDeviceSession.
let mdReconcilePromise: Promise<void> | null = null;
const MD_RECONCILE_TIMEOUT_MS = 8000;
// Event id of the tip currently being reconciled by `handleTipEvent`, or null.
// Re-entrancy guard: see handleTipEvent. Sync check-and-set before the first await.
let inflightTipEventId: string | null = null;

/**
 * Subscribe to the tip replaceable event for the active owner's config and
 * reconcile on every change. Idempotent: re-subscribing tears down the prior
 * subscription first. No-op when disabled.
 */
function startTipSubscription(): void {
	if (!browser) return;
	const config = getMultiDeviceConfig();
	if (!config) return;
	stopTipSubscription();
	const ownerPubkey = normalizePubKey(manager.getActive()!.pubkey);
	// Relay burst → eventStore: the store keeps only the newest addressable
	// version per (kind, pubkey, d), so this IS the replaceable-version dedup
	// (spec §10.5). No hand-rolled created_at gate needed on the read path —
	// mirrors the donations/profiles pattern already used elsewhere.
	const model = eventStore
		.addressable({
			kind: MULTI_DEVICE_TIP_KIND,
			pubkey: config.ephemeralPubkey,
			identifier: config.dTag
		})
		.subscribe((event) => {
			if (!event) return;
			void handleTipEvent(event, ownerPubkey).catch((error) => {
				console.warn('[multi-device] tip reconcile failed', error);
			});
		});
	const feed = relayPool
		.subscription(
			config.relays,
			{ kinds: [MULTI_DEVICE_TIP_KIND], authors: [config.ephemeralPubkey], '#d': [config.dTag] },
			{ reconnect: Infinity, resubscribe: true }
		)
		.pipe(mapEventsToStore(eventStore))
		.subscribe();
	tipSubscription = {
		unsubscribe() {
			model.unsubscribe();
			feed.unsubscribe();
		}
	};
}

function stopTipSubscription(): void {
	if (tipSubscription) {
		try {
			tipSubscription.unsubscribe();
		} catch {
			/* best-effort */
		}
		tipSubscription = null;
	}
}

/** §10.6 gate: reconcile the tip once per session before the delivery stream
 * opens, so cold-start backlog fetches see a fast-forwarded state. Idempotent
 * (concurrent awaiters join the in-flight reconcile); no-op when MD is off.
 * Reset by {@link resetMultiDeviceSession}. */
export function awaitMultiDeviceReconciled(): Promise<void> {
	if (!browser) return Promise.resolve();
	if (mdReconcilePromise) return mdReconcilePromise;
	const config = getMultiDeviceConfig();
	if (!config) return Promise.resolve();
	mdReconcilePromise = startMultiDevice();
	return mdReconcilePromise;
}

/** One-shot cold-start reconcile + open the live tip subscription. Bounded:
 * if the reconcile overruns, fall back to the mdActive gate so delivery isn't
 * blocked (§10.6 "behind is not corruption"). */
async function startMultiDevice(): Promise<void> {
	const account = manager.getActive();
	const config = account ? getMultiDeviceConfig() : null;
	if (!account || !config) return;
	const ownerPubkey = normalizePubKey(account.pubkey);
	const reconcile = async () => {
		try {
			const tipEvent = await fetchLatestTipEvent(config);
			if (tipEvent) await handleTipEvent(tipEvent, ownerPubkey);
		} catch (error) {
			dbg('startMultiDevice reconcile failed', { error });
		}
	};
	await Promise.race([
		reconcile(),
		new Promise<void>((resolve) => setTimeout(resolve, MD_RECONCILE_TIMEOUT_MS))
	]);
	startTipSubscription();
	// §10.5 trigger "on startup if local state is ahead of the tip" — evaluated
	// even when the reconcile deduped (tip unchanged / event id seen): both
	// signals are pure-local (stale-epoch record + meta view hash), no fetch.
	// This is the heal moment for a change stranded by a deferred / failed /
	// process-killed publish, which the tip-event path can never see (the tip
	// never moved). A racing mid-flight reconcile is benign: runSerialized
	// orders the publishes and the sweep converges on its own reconcile.
	scheduleOwedPublish();
	// §8 fetch liveness: retry document pulls that failed in a previous session —
	// a cold start MUST NOT inherit a previous fetch failure as a permanent skip.
	scheduleUnresolvedRetry();
}

/** Pure-local owed-publish check (§10.5): schedules a republish when any live
 *  group's local epoch is strictly ahead of the owed-push record, or the meta
 *  view hash no longer matches the last published one. Shared shape with
 *  handleTipEvent's divergence diff minus its fetch-gated signals. Fetches its
 *  OWN config — `getMultiDeviceConfig()` returns a fresh JSON.parse per call,
 *  so a config captured before the startup reconcile would miss the records
 *  that reconcile just wrote and schedule a spurious publish. */
function scheduleOwedPublish(): void {
	const config = getMultiDeviceConfig();
	if (!config) return;
	const liveGroups = collectActiveGroups();
	const staleGids = diffStaleGroupEpochs({
		localEpochs: collectLocalGroupEpochs(liveGroups),
		publishedEpochs: config.publishedGroupEpochs
	});
	const removed = composeTombstoneUnion(
		config.pendingTombstones ?? [],
		config.carriedTombstones ?? [],
		liveGroups.map((g) => g.id)
	);
	const metaAhead =
		metaViewHash({
			lastResortKeyPackage: getLastResortKeyPackageEntry(),
			removed
		}) !== config.lastPublishedMetaHash;
	if (staleGids.length || metaAhead) {
		dbg('startup owed republish', { groups: staleGids.length, meta: metaAhead });
		scheduleRepublish({ resealGroups: staleGids, resealMeta: metaAhead });
	}
}

/** Tear down the session: clear the reconcile promise + stop the tip
 * subscription. Called on account change + disable so the next start
 * re-reconciles for the new owner. */
export function resetMultiDeviceSession(): void {
	mdReconcilePromise = null;
	stopTipSubscription();
}

/** Outcome of a manual `reconcileMultiDeviceNow()`. The non-ok statuses keep
 * "no groups because sync is off" distinct from "no groups because the tip is
 * unreachable or undecryptable" — previously all collapsed into `null` and the
 * UI rendered the same message for every cause. */
export type MultiDeviceReconcileResult =
	| { status: 'ok'; counts: ReconcileCounts }
	| { status: 'off' | 'no-account' | 'signer-no-nip44' | 'no-tip' | 'unreadable-tip' };

/** Manual one-shot reconcile (diagnostic / recovery). Fetches the tip +
 * reconciles (§8), bypassing the in-session dedup so a repeat click always
 * re-applies. Used by the config-page "Re-sync now" action. No-op when sync is
 * off / no account; does not start the live subscription. */
export async function reconcileMultiDeviceNow(): Promise<MultiDeviceReconcileResult> {
	if (!browser) return { status: 'off' };
	const config = getMultiDeviceConfig();
	if (!config) return { status: 'off' };
	const account = manager.getActive();
	if (!account) return { status: 'no-account' };
	// Same capability gate as link/enable: without nip44 the tip seal cannot be
	// decrypted at all, which is a signer problem, not a relay one.
	if (!account.nip44) return { status: 'signer-no-nip44' };
	const ownerPubkey = normalizePubKey(account.pubkey);
	dbg('reconcileMultiDeviceNow enter', { dTag: config.dTag.slice(0, 8) });
	const tipEvent = await fetchLatestTipEvent(config);
	if (!tipEvent) {
		dbg('reconcileMultiDeviceNow no tip found');
		return { status: 'no-tip' };
	}
	// Bypass the per-doc + per-event dedup: a manual trigger should always
	// re-apply, even if the tip address/event id matches the last auto-reconcile.
	config.lastSeenTip = undefined;
	config.lastSeenTipEventId = undefined;
	saveConfig(config);
	const counts = await handleTipEvent(tipEvent, ownerPubkey);
	if (!counts) return { status: 'unreadable-tip' };
	dbg('reconcileMultiDeviceNow done', { counts });
	return { status: 'ok', counts };
}

let unresolvedRetryTimer: ReturnType<typeof setTimeout> | undefined;

/** Spec §8 fetch liveness: is this gid's document fetch still failing? */
export function isGroupDocumentPullUnresolved(gid: string): boolean {
	const config = getMultiDeviceConfig();
	return !!config?.unresolvedDocumentPulls?.[gid];
}

/**
 * Arm the next failed-pull retry (spec §8 fetch liveness). ONE timer covers
 * both retry jobs: re-pulling failed documents AND re-fetching the tip (the
 * dead-tip-subscription fallback — a fresh `fetchLatestTipEvent` request
 * reaches the relay even when the subscription is half-open and silent), so
 * polling exists only while something is broken. Idempotent re-arm.
 */
function scheduleUnresolvedRetry(): void {
	if (unresolvedRetryTimer !== undefined) clearTimeout(unresolvedRetryTimer);
	unresolvedRetryTimer = undefined;
	if (!browser) return;
	const entries = Object.values(getMultiDeviceConfig()?.unresolvedDocumentPulls ?? {});
	if (!entries.length) return;
	const now = Date.now();
	// Fire for the SOONEST due entry; the rest re-check their own backoff then.
	const dueIn = nextPullRetryDelayMs(entries, now);
	unresolvedRetryTimer = setTimeout(() => {
		void retryUnresolvedPulls();
	}, dueIn);
}

async function retryUnresolvedPulls(): Promise<void> {
	try {
		const config = getMultiDeviceConfig();
		const account = manager.getActive();
		if (!config || !account) return;
		// Fresh tip fetch: covers the tip-moved-while-the-sub-was-dead case as well
		// as the plain same-address retry (`handleTipEvent` lets a replayed event id
		// through while unresolved pulls exist).
		const tipEvent = await fetchLatestTipEvent(config);
		if (tipEvent) await handleTipEvent(tipEvent, normalizePubKey(account.pubkey));
	} catch (error) {
		dbg('unresolved pull retry failed', { error: errorMessage(error) });
	} finally {
		scheduleUnresolvedRetry();
	}
}

/** §10 mitigation #1: reconcile the tip before staging an epoch-advancing Commit
 * (invite / remove / metadata). If a sibling Commit advanced the group's epoch,
 * this fast-forwards the local state first, so the outbound Commit isn't authored
 * from a behind epoch (which siblings would drop as a former-epoch message).
 * Self-heals instead of refusing — strictly better UX than the spec's "refuse to
 * stage" wording, and the device is no longer behind once the reconcile runs.
 *
 * Delta-gated: `handleTipEvent` bails on `lastSeenTipEventId` when no peer moved
 * the tip, so the common case is one relay round-trip (`fetchLatestTipEvent`,
 * capped at 2s for the outbound path so a degraded relay can't stall an admin
 * op — on timeout user ops proceed without the reconcile and the tip subscription
 * re-converges). No-op when MD is off. Returns whether the tip was reconciled:
 * user ops proceed either way (a network blip must not block them; the
 * coordinator catch-up + sibling-skip still guard correctness), while the
 * §10.1 repair discipline defers on `false` instead of committing from stale
 * state. The tip subscription re-converges on its own.
 *
 * The explicit `fetchLatestTipEvent` (a fresh `relayPool.request`, NOT a
 * subscription read) is also what heals a half-open tip subscription for the
 * outbound path: a socket the relay pool still considers alive but has stopped
 * delivering on is invisible to the `reconnect: Infinity` auto-reconnect, yet a
 * one-off request still reaches the relay and returns the current tip. Combined
 * with the read-path divergence diff (§10.5 "local ahead of tip"), correctness
 * holds even with a dead sub; only idle liveness (no outbound ops, no
 * cold-start) is degraded until the sub detects the drop.
 *
 * ponytail: covers the common race (sibling published its group document but the
 * tip subscription hasn't delivered it yet). The narrower window — sibling Commit
 * on the coordinator stream before its group document is published — is left to
 * the tip subscription's seconds-later convergence; the spec marks full
 * auto-resolution of that as disproportionate (§10 mitigation #3). */
export async function reconcileTipForOutbound(): Promise<boolean> {
	if (!browser) return true;
	const config = getMultiDeviceConfig();
	if (!config) return true;
	const account = manager.getActive();
	if (!account) return true;
	try {
		const tipEvent = await fetchLatestTipEvent(config, 2000);
		if (!tipEvent) return false; // no tip / fetch timeout → tip state unknown
		await handleTipEvent(tipEvent, normalizePubKey(account.pubkey));
		// Success = this tip is now recorded (setLastSeenTip runs after applyTip).
		// A parse / DEK / apply failure leaves the id unrecorded → "unknown", and
		// the §10.1 repair discipline must treat unknown as not-reconciled.
		return getMultiDeviceConfig()?.lastSeenTipEventId === tipEvent.id;
	} catch (error) {
		dbg('reconcileTipForOutbound failed', {
			error: errorMessage(error)
		});
		return false;
	}
}

/** Reconcile outcome counts surfaced to callers (UI / link flow / logs). */
export interface ReconcileCounts {
	seeded: number;
	fastForwarded: number;
	/** Equal-epoch forks resolved via the spec §10 rank tie-break. Optional for
	 *  tip-history entries persisted before this field existed. */
	forkResolved?: number;
	skipped: number;
	dropped: number;
	ignored: number;
}

/**
 * One entry in the per-owner tip transition log (dev visibility). Newest first.
 * `source` distinguishes a peer tip we ingested (`read`) from our own publish
 * (`write`) — the core debugging question when sync looks stuck.
 */
export interface TipTransition {
	at: number;
	eventId: string;
	source: 'read' | 'write';
	/** Counts from the `applyTip` that ran alongside (read path always; write
	 * path's reconcile-before-push). Undefined only if applyTip was skipped. */
	counts?: ReconcileCounts;
	added: TipGroupPointer[];
	removed: TipGroupPointer[];
	changed: TipGroupPointer[];
	metaChanged: boolean;
	/** Meta document content address recorded in this transition — the address
	 * published/ingested here when `metaChanged`. Lets the dev panel surface the
	 * exact hash to inspect on a Blossom host. Absent on transitions logged
	 * before this field existed. */
	metaAddress?: string;
}

/** Read-order server list: the tip's advertised hosts first, then the configured fallbacks. */
function readServers(pointer: TipPointer, config: MultiDeviceOwnerConfig | undefined): string[] {
	return [...pointer.servers, ...(config?.blossomServers ?? BLOSSOM_SERVERS)];
}

/**
 * Read-only content-addressed store: try each server in order for the blob's
 * address (the URL's last path segment). The single read store for every path
 * — per-doc tip pulls and the §8.5 chain walk.
 */
function makeReadStore(servers: string[]): BlobStore {
	const clean = [...new Set(servers.map((s) => s.replace(/\/+$/, '')))].filter(Boolean);
	return {
		async publish() {
			throw new Error('read-only store');
		},
		async fetch(url: string) {
			const address = url.split('/').pop() ?? '';
			// Race all servers — content-addressed, so any holder is a valid source.
			// First response wins; only fails if every server fails. The old
			// sequential `for`-loop paid N full (untimed) waits when the first-listed
			// server was slow or down, stalling the cold-link seed for every group.
			try {
				const controller = new AbortController();
				return await Promise.any(
					clean.map(async (server) => {
						const blob = await fetchBlob(`${server}/${address}`, controller.signal);
						controller.abort(); // first winner → cancel the losers' downloads
						dbg('read store fetch', {
							winner: server,
							racing: clean.length,
							address: address.slice(0, 12)
						});
						return blob;
					})
				);
			} catch (agg) {
				const errors = agg instanceof AggregateError ? agg.errors : [agg];
				throw new Error(
					`Could not fetch document from any server: ${errors
						.map((e) => errorMessage(e))
						.join('; ')}`,
					{ cause: agg }
				);
			}
		}
	};
}

/**
 * Pull one group document from the tip and reconcile it (spec §8). Reloads the
 * in-memory group store when the group is seeded. `groupAddress` threads into
 * the chained catch-up (spec §8.5) as the walk's tip address.
 */
async function pullAndReconcileGroup(
	group: TipGroupPointer,
	pointer: TipPointer,
	dekSeal: Nip44Seal,
	dekPubkey: string,
	config: MultiDeviceOwnerConfig | undefined
): Promise<{ doc: GroupDocument; outcome: ReconcileOutcome }> {
	const store = makeReadStore(readServers(pointer, config));
	const doc = await pullDocument({
		address: group.address,
		store,
		addressToUrl: (a) => urlFromTip(a, pointer),
		seal: dekSeal,
		dekPubkey
	});
	if (doc.type !== 'group') {
		throw new MultiDeviceError('Tip group tag pointed at a non-group document');
	}
	const outcome = await makeReconcileTarget({
		groupAddress: group.address,
		pointer,
		dekSeal,
		dekPubkey,
		config
	}).applyGroupDocument(doc, group.address);
	// No store reload: seedGroup adds via persistGroup (reactive store + IDB in
	// one shot), and fast-forward mutates an existing record in place
	// (replaceGroup). The store is current for the caller + reactive UI.
	return { doc, outcome };
}

/** Pull the meta document from the tip and reconcile tombstones + key package. */
async function pullAndReconcileMeta(
	pointer: TipPointer,
	dekSeal: Nip44Seal,
	dekPubkey: string,
	config: MultiDeviceOwnerConfig | undefined
): Promise<{
	doc: MetaDocument;
	counts: { dropped: number; ignored: number; keyPackageLoaded: boolean };
}> {
	if (!pointer.metaAddress) throw new Error('No meta address in tip');
	const store = makeReadStore(readServers(pointer, config));
	const doc = await pullDocument({
		address: pointer.metaAddress,
		store,
		addressToUrl: (a) => urlFromTip(a, pointer),
		seal: dekSeal,
		dekPubkey
	});
	if (doc.type !== 'meta') {
		throw new MultiDeviceError('Tip meta tag pointed at a non-meta document');
	}
	const result = await reconcileMetaDocument(makeReconcileTarget(), doc);
	return {
		doc,
		counts: {
			dropped: result.dropped.length,
			ignored: result.ignored.length,
			keyPackageLoaded: result.keyPackageLoaded
		}
	};
}

/**
 * Reconcile a tip event: per-gid + per-meta DELTA against the last-seen tip
 * (spec §6 — pull only documents whose address changed). A gid that vanished
 * from the tip was soft-deleted by the peer; its tombstone arrives via the meta
 * document. The eventStore already dedups identical replaceable replays, so we
 * are only called with a genuinely newer tip.
 */
async function handleTipEvent(
	outer: NostrEvent,
	ownerPubkey: string
): Promise<ReconcileCounts | null> {
	const config = getMultiDeviceConfig();
	// §10.5 tip-address check: an event id we've already processed is our own
	// self-echo (publish loopback) or a duplicate relay delivery — skip without
	// parsing or fetching. This is the cheap dedup layer above the per-doc
	// address delta. EXCEPT while a document fetch is unresolved (§8 fetch
	// liveness): a relay replay of the last tip is then a retry opportunity, not
	// noise — the per-gid backoff gate inside `applyTip` bounds the attempts.
	if (
		config?.lastSeenTipEventId === outer.id &&
		!Object.keys(config.unresolvedDocumentPulls ?? {}).length
	)
		return null;
	// Re-entrancy guard: the same tip can arrive concurrently — a cold reconcile
	// overlapping the live subscription, or a relay burst — before setLastSeenTip
	// records the event id (which only happens AFTER applyTip). lastSeenTipEventId
	// gates too late for those: without this, each duplicate would run a full
	// 13-group reconcile in parallel and race a concurrent seedGroup on the same
	// absent group. Check-and-set BEFORE the first await — JS is single-threaded, so
	// a sibling delivery in the same tick reads the flag we just set and bails.
	if (inflightTipEventId === outer.id) return null;
	inflightTipEventId = outer.id;
	try {
		const parsed = await parseTipEvent(outer, ownerPubkey);
		if (!parsed) return null;
		if (!config) return null;

		// Adopt the tip's DEK (spec §6 `dek` tag): the channel a linked device obtains
		// the DEK through, so document decrypts are local from here on (§7). The
		// source device already holds its own; the idempotent check skips a rewrite.
		if (parsed.dekPrivateKey && parsed.dekPrivateKey !== config.dekPrivateKey) {
			config.dekPrivateKey = parsed.dekPrivateKey;
			saveConfig(config);
		}
		const dek = getDekSeal(config);
		if (!dek) return null; // no DEK → cannot decrypt documents (§7)
		const pointer = parsed.pointer;

		dbg('handleTipEvent', {
			groups: pointer.groups.length,
			meta: !!pointer.metaAddress,
			cold: !config.lastSeenTip
		});

		// Populate the group-loading total for an active user-initiated flow (link).
		// Background subscription cycles leave phase null → no-op there, so
		// steady-state reconciles never surface a bar.
		if (mdProgress.phase && pointer.groups.length) {
			setMdProgress('Loading groups', 0, pointer.groups.length);
		}

		// Ingest via the shared chokepoint (same reconcile the write path runs before
		// every push), then record the peer tip as the last-seen one.
		const { counts, localAheadGids } = await applyTip(pointer, {
			dekSeal: dek.seal,
			dekPubkey: dek.dekPubkey,
			config
		});
		setLastSeenTip(config, pointer, outer.id, { source: 'read', counts });

		// §8 / §10.5 "local ahead of tip" trigger: if reconciling this peer tip left
		// local state newer than what the tip carries, schedule a push so siblings
		// converge. Three signals, none needing an extra fetch:
		//  - `missingFromTip`: local gids absent from the tip's group list. Closes
		//    link-from-an-empty-device (every local group the empty tip lacks) and
		//    backup-restore. A tombstoned-stale gid (epoch below local) is absent
		//    from the group list too, so it lands here — republishing it is the §8
		//    resurrection, which is correct.
		//  - `epochsAhead`: gids whose fetched document was at a local epoch ≥
		//    incoming (the §8 'skipped' outcome). Catches a peer tip re-delivering a
		//    doc we already surpassed.
		//  - `staleEpochs`: local strictly ahead of the owed-push record
		//    (§10.5). Closes the former residual — a republish interrupted by tab
		//    close / a deferred or failed push — which neither signal above can see
		//    (tip address unchanged → no fetch → no epoch compare). The heal is a
		//    push on next read, next publish (the write path unions stale gids),
		//    or next startup (`scheduleOwedPublish`), whichever comes first.
		// The missed-own-commit-self-echo case (a Commit whose republish never fired
		// because the self-echo wasn't observed) is closed by the EAGER hook in
		// `runOutboundGroupOperation` firing unconditionally — not by this diff.
		// Loop-safe: once the missing groups/meta are pushed, the next read finds
		// no divergence and this is a no-op. Gated to the READ path only — the
		// write path (`publish`) drives its own re-seal plan and must not queue a
		// redundant second publish here.
		const liveGroupsForDiff = collectActiveGroups();
		const liveGids = liveGroupsForDiff.map((g) => g.id);
		const localAhead = diffLocalAhead({
			localGids: liveGids,
			tipGids: pointer.groups.map((g) => g.gid),
			epochsAheadGids: localAheadGids
		});
		const staleGids = diffStaleGroupEpochs({
			localEpochs: collectLocalGroupEpochs(liveGroupsForDiff),
			publishedEpochs: config.publishedGroupEpochs
		});
		const localAheadUnion = [...new Set([...localAhead, ...staleGids])];
		const removed = composeTombstoneUnion(
			config.pendingTombstones ?? [],
			config.carriedTombstones ?? [],
			liveGids
		);
		const metaAhead =
			metaViewHash({
				lastResortKeyPackage: getLastResortKeyPackageEntry(),
				removed
			}) !== config.lastPublishedMetaHash;
		if (localAheadUnion.length || metaAhead) {
			dbg('handleTipEvent scheduling local-ahead republish', {
				groups: localAheadUnion.length,
				meta: metaAhead
			});
			scheduleRepublish({
				resealGroups: localAheadUnion,
				resealMeta: metaAhead
			});
		}

		dbg('handleTipEvent done', { counts });
		return counts;
	} finally {
		if (inflightTipEventId === outer.id) inflightTipEventId = null;
	}
}

/**
 * Build a `ReconcileTarget` over the live group store. Seed installs a new
 * `StoredChatGroup`; fast-forward replaces state+cursor only at a strictly newer
 * epoch (§8); tombstones drop a group whose epoch ≤ the tombstone (§8, anti-
 * downgrade).
 */
function makeReconcileTarget(catchUp?: {
	groupAddress: string;
	pointer: TipPointer;
	dekSeal: Nip44Seal;
	dekPubkey: string;
	config: MultiDeviceOwnerConfig | undefined;
}): ReconcileTarget {
	return {
		localEpoch(gid) {
			const group = getChatGroup(gid);
			if (!group) return undefined;
			return decodeStoredGroupState(group).groupContext.epoch;
		},
		async applyGroupDocument(doc, address) {
			const existing = getChatGroup(doc.gid);
			const incomingEpoch = groupEpoch(doc);
			if (!existing) {
				// Undecodable is advisory garbage — never installs (spec §8/§10).
				if (incomingEpoch === undefined) return 'skipped';
				// ownerPubkey labels the seeded group record (the active identity); the
				// seal is confidentiality-only (DEK), not used for labeling.
				const account = requireActiveAccount('You must be logged in to seed a group');
				await seedGroup(doc, normalizePubKey(account.pubkey), address);
				return 'seeded';
			}
			const localState = decodeStoredGroupState(existing);
			const localEpoch = localState.groupContext.epoch;
			const incomingState = clientStateDecoder(base64ToBytes(doc.clientState), 0)?.[0];
			// §8 forward-only epoch check + §10 detection: fork identity is the
			// epoch fingerprint, never the content address — a re-publish of one
			// state re-seals (new address) and is advisory, not a fork.
			const decision = decideGroupDocumentApply({
				incomingEpoch,
				localEpoch,
				incomingFingerprint: incomingState ? stateFingerprint(incomingState) : undefined,
				localFingerprint: stateFingerprint(localState)
			});
			if (decision === 'skipped') return 'skipped';
			// A newer-epoch document is an advance only when its branch descends
			// from the local state (spec §8): the `prev` chain either passes through
			// our state at our epoch, or meets a state we held at an earlier epoch —
			// a fork that has since committed on, which the plain forward-only rule
			// would carry this device onto. Without chain access the forward-only
			// rule applies (liveness first).
			let forkEpoch: bigint | undefined = decision === 'fork' ? localEpoch : undefined;
			const chain = catchUp
				? {
						store: makeReadStore(readServers(catchUp.pointer, catchUp.config)),
						addressToUrl: (a: string) => urlFromTip(a, catchUp.pointer),
						seal: catchUp.dekSeal,
						dekPubkey: catchUp.dekPubkey
					}
				: undefined;
			if (decision === 'fast-forwarded' && chain && incomingState) {
				const links = await fetchChainFingerprints({
					startPrev: doc.prev,
					groupId: doc.gid,
					...chain
				});
				const descent = classifyChainDescent(links, existing.epochFingerprints ?? {}, localEpoch);
				if (descent !== 'unknown' && descent !== 'descends') forkEpoch = descent.epoch;
			}
			if (forkEpoch !== undefined && incomingState) {
				return resolveGroupFork({
					existing,
					localState,
					theirs: incomingState,
					doc,
					address,
					forkEpoch,
					chain
				});
			}
			// Capture the pre-fast-forward decrypt frontier + local state. fast-forward
			// advances both to the tip, so the chained catch-up (spec §8.5) needs the
			// values from BEFORE it ran to know where the lossless gap starts and
			// what state decrypts range 0.
			const decryptFrontier = existing.fetchCursor;
			const localStateBase64 = existing.stateBase64;
			await fastForwardGroup(doc, address); // liveness first (locked CAS write)
			// Background lossless recovery (§8.5): replay the message gap epoch-by-epoch
			// so messages sent during the behind window aren't lost. Fire-and-forget —
			// fast-forward already restored liveness. Skipped when the decrypt frontier
			// is already at the adopted cursor: an online device sibling-skipped the
			// Commit on the stream, so there's no gap to recover (saves the chain walk
			// + gap fetch on every online sibling-Commit fast-forward). A §10 fork
			// adoption has no chain to bridge — the losing branch is gone by design.
			if (catchUp && decryptFrontier < doc.cursor) {
				void catchUpGroupFromChain({
					groupId: doc.gid,
					localEpoch,
					localStateBase64,
					decryptFrontier,
					groupAddress: catchUp.groupAddress,
					pointer: catchUp.pointer,
					dekSeal: catchUp.dekSeal,
					dekPubkey: catchUp.dekPubkey,
					config: catchUp.config
				}).catch((error) =>
					dbg('catchUp failed; fast-forward preserved liveness', {
						gid: doc.gid,
						error: errorMessage(error)
					})
				);
			}
			return 'fast-forwarded';
		},
		async applyTombstone(tombstone) {
			const existing = getChatGroup(tombstone.gid);
			if (!existing) {
				return 'ignored'; // unknown to this device
			}
			const localEpoch = decodeStoredGroupState(existing).groupContext.epoch;
			if (BigInt(tombstone.epoch) < localEpoch) {
				return 'ignored'; // stale tombstone (spec §8 anti-downgrade)
			}
			deleteChatGroup(tombstone.gid);
			dbg('applyTombstone dropped', {
				gid: tombstone.gid,
				tombstoneEpoch: tombstone.epoch,
				localEpoch: String(localEpoch)
			});
			return 'dropped';
		},
		async loadLastResortKeyPackage(entry) {
			return loadLastResortKeyPackage(entry);
		}
	};
}

/** Seed a missing group from a group document (spec §9). */
async function seedGroup(doc: GroupDocument, ownerPubkey: string, address?: string): Promise<void> {
	// ponytail: joinEpoch 0 — seeded groups adopt the writer's current state via
	// clientState, so there's no pre-membership boundary to filter (spec §9).
	const epoch = groupEpoch(doc);
	const seededState = clientStateDecoder(base64ToBytes(doc.clientState), 0)?.[0];
	const seededFingerprint = seededState ? stateFingerprint(seededState) : undefined;
	const seeded: StoredChatGroup = {
		id: doc.gid,
		ownerPubkey,
		coordinatorKey: doc.coordinator,
		createdAt: Date.now(),
		stateBase64: doc.clientState,
		lastCursor: doc.cursor,
		fetchCursor: doc.cursor,
		// Adopted document identity (spec §10) — absent only when the fetched
		// address was unknown.
		...(address
			? {
					appliedDocument: {
						address,
						cursor: doc.cursor,
						...(seededFingerprint ? { fingerprint: seededFingerprint } : {})
					}
				}
			: {}),
		// Held-state history for the §8 descent check (spec §10 detection).
		...(seededFingerprint
			? { epochFingerprints: noteStateFingerprint(undefined, seededState!) }
			: {}),
		messages: [],
		syncIssues: [],
		// Initial healthy snapshot — the recovery baseline `loadAndNormalizeChatGroup`
		// would mint on next reload. Built inline so persistGroup (reactive store +
		// IDB in one shot) needs no full reload. cursor is the adopted cursor: the
		// state is valid AT doc.cursor, not cursor 0 (unlike create/join, whose
		// fetchCursor is still 0).
		snapshots: [
			{
				groupId: doc.gid,
				status: 'healthy',
				epoch: epoch ? epoch.toString() : '0',
				cursor: doc.cursor,
				createdAt: Date.now(),
				stateBase64: doc.clientState
			}
		],
		metadata: groupMetadata(doc),
		joinEpoch: 0n,
		status: 'active'
	};
	// Add to the reactive store + persist in one shot — the create/join seam's
	// primitive. The store updates synchronously, so the caller's
	// collectActiveGroups and the reactive UI see the seeded group at once; no
	// reloadChatGroupsForOwner (full IDB scan) needed.
	persistGroup(seeded);
	dbg('seedGroup', { gid: doc.gid.slice(0, 8), epoch: String(epoch) });
	// Establish the coordinator relationship so it appears in the coordinator list
	// and operational queries (available key packages, welcomes) — mirrors the
	// create/join seam. Idempotent if the coordinator is already known. Relay
	// hints from the document adopt fill-if-empty (spec §9).
	markCoordinatorUsed(doc.coordinator, doc.coordinatorRelays);
}

/**
 * Fast-forward a group to a strictly newer epoch (§8), or — with
 * `allowEqualEpoch` — adopt the ranked winner of a §10 equal-epoch fork (the
 * single forward-only exception). Runs under the per-group lock
 * (`runGroupOperation`) so it can't clobber (nor be clobbered by) a
 * concurrent live-delivery cycle — both mutate the same record. Re-reads +
 * re-checks the epoch UNDER the lock (CAS): a watch cycle may have caught up
 * while we waited, in which case this is a no-op.
 */
async function fastForwardGroup(
	doc: GroupDocument,
	address?: string,
	opts?: { allowEqualEpoch?: boolean; forkDecision?: StoredForkDecision }
): Promise<void> {
	await runGroupOperation(doc.gid, async () => {
		const existing = getChatGroup(doc.gid);
		if (!existing) return; // vanished (soft-deleted) while waiting for the lock
		const decoded = clientStateDecoder(base64ToBytes(doc.clientState), 0)?.[0];
		const incomingEpoch = decoded?.groupContext.epoch;
		const localEpoch = decodeStoredGroupState(existing).groupContext.epoch;
		// Re-check under the lock (CAS): a concurrent cycle may have caught up.
		if (incomingEpoch === undefined || !decoded) return;
		if (opts?.allowEqualEpoch ? incomingEpoch !== localEpoch : incomingEpoch <= localEpoch) return;
		const fingerprint = stateFingerprint(decoded);
		replaceGroup(existing.id, {
			...existing,
			stateBase64: doc.clientState,
			metadata: groupMetadata(doc),
			coordinatorKey: doc.coordinator,
			// Cursor advances to the document's (the adopted state processed through it).
			fetchCursor: Math.max(existing.fetchCursor, doc.cursor),
			lastCursor: Math.max(existing.lastCursor, doc.cursor),
			// Adopted document identity (spec §10) — fork detection needs it;
			// absent when the fetched address was unknown (pre-fork docs).
			...(address ? { appliedDocument: { address, cursor: doc.cursor, fingerprint } } : {}),
			// Held-state history grows with the adopted state (spec §8 descent check).
			epochFingerprints: noteStateFingerprint(existing.epochFingerprints, decoded),
			// The recorded fork winner (spec §10): the rank alone never overturns it.
			...(opts?.forkDecision ? { forkDecision: opts.forkDecision } : {}),
			// Adoption clears the race evidence (spec §10): what this device knew
			// about its own Commit's race no longer describes the adopted state.
			branch: undefined,
			skippedSiblingCommit: undefined,
			commitPoint: undefined,
			// §10 conflict signal: a resolved fork MUST be surfaced, not silent.
			...(opts?.forkDecision
				? {
						syncIssues: [
							...existing.syncIssues.filter((issue) => issue.cursor !== doc.cursor),
							{
								cursor: doc.cursor,
								createdAt: Date.now(),
								detail: `Fork at epoch ${opts.forkDecision.epoch} resolved: adopted the other branch (${opts.forkDecision.by})`
							}
						]
					}
				: {}),
			// The adopted state is authoritative (owner-signed, content-addressed), so
			// clear any transient poisoning from the stale-state ingestion window — an
			// ahead-of-local-epoch message the device couldn't decrypt before this
			// fast-forward arrived. Removal is a genuine MLS event, not transient, so
			// it is left intact (spec §8).
			...(existing.status === 'poisoned'
				? { status: 'active' as const, poisonedAtCursor: undefined }
				: {})
		});
		// Spec §9 relay-hint adoption applies to fast-forwarding too (the doc's
		// coordinator may differ from the locally stored one). Inside the lock,
		// after the CAS check, so hints adopt exactly when state adopts.
		markCoordinatorUsed(doc.coordinator, doc.coordinatorRelays);
		dbg('fastForwardGroup', {
			gid: existing.id.slice(0, 8),
			epoch: `${localEpoch}→${incomingEpoch}`,
			cursor: doc.cursor,
			msgs: existing.messages.length,
			unpoisoned: existing.status === 'poisoned'
		});
	});
}

/** Decode a base64 gen-0 ClientState (throws if undecodable). */
function decodeClientStateBase64(base64: string): ClientState {
	const decoded = clientStateDecoder(base64ToBytes(base64), 0);
	if (!decoded) throw new Error('Unable to decode client state');
	return decoded[0];
}

/** Fetch the raw message gap from a cursor (spec §8.5 gap fetch). */
/**
 * Walk a `prev` chain from `startPrev`, collecting each document's epoch
 * fingerprint for the §8 descent check (spec §8). A link that cannot be read
 * ends the walk — `classifyChainDescent` treats the tail as `unknown`, which
 * keeps the forward-only advance (liveness first).
 */
async function fetchChainFingerprints(params: {
	startPrev: string | undefined;
	groupId: string;
	store: BlobStore;
	addressToUrl: (address: string) => string;
	seal: Nip44Seal;
	dekPubkey: string;
}): Promise<ChainFingerprint[]> {
	const links: ChainFingerprint[] = [];
	let address = params.startPrev;
	for (let hop = 0; hop < 1000 && address; hop++) {
		let doc;
		try {
			doc = await pullDocument({
				address,
				store: params.store,
				addressToUrl: params.addressToUrl,
				seal: params.seal,
				dekPubkey: params.dekPubkey
			});
		} catch {
			break;
		}
		if (doc.type !== 'group' || doc.gid !== params.groupId) break;
		const decoded = clientStateDecoder(base64ToBytes(doc.clientState), 0);
		if (!decoded) break;
		links.push({ epoch: decoded[0].groupContext.epoch, fingerprint: stateFingerprint(decoded[0]) });
		address = doc.prev;
	}
	return links;
}

/**
 * One fork branch's §10.3 rank input: the lowest-cursor document at the fork
 * epoch on its `prev` chain — the commit-point document, whose cursor is that
 * Commit's position in the stream. `walkGroupChain` already keeps exactly the
 * oldest document per epoch, so it does the walk unchanged. `undefined` where
 * the chain carries none at that epoch or cannot be read — the live-document
 * rank then decides (spec §10.3).
 */
async function forkBranchCommitRank(params: {
	tipAddress: string;
	groupId: string;
	forkEpoch: bigint;
	store: BlobStore;
	addressToUrl: (address: string) => string;
	seal: Nip44Seal;
	dekPubkey: string;
}): Promise<{ cursor: number; address: string } | undefined> {
	try {
		const chain = await walkGroupChain({
			tipAddress: params.tipAddress,
			groupId: params.groupId,
			localEpoch: params.forkEpoch - 1n,
			store: params.store,
			addressToUrl: params.addressToUrl,
			seal: params.seal,
			dekPubkey: params.dekPubkey
		});
		const step = chain.find((s) => s.epoch === params.forkEpoch);
		return step ? { cursor: step.cursor, address: step.address } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Spec §10 step 2 (third-party verdict): which branch do the other members
 * follow? Fetch messages past the local cursor and run each under both
 * branches on throwaway probes; the first from another leaf — an application
 * message, or a Commit that applies — that opens under exactly one branch's
 * keys names it. A Commit or a message from our own shared leaf carries no
 * signal. `true` = theirs, `false` = ours, `undefined` = nothing to judge (or
 * the fetch failed — the fallback rank still converges).
 */
async function thirdPartyVerdict(params: {
	group: StoredChatGroup;
	theirs: ClientState;
}): Promise<boolean | undefined> {
	const local = decodeStoredGroupState(params.group);
	let messages: Awaited<ReturnType<typeof fetchMessageGap>>;
	try {
		messages = await fetchMessageGap(
			params.group,
			getProtocolGroupId(local),
			params.group.fetchCursor
		);
	} catch {
		return undefined;
	}
	const localStablePubkey = params.group.ownerPubkey ?? '';
	let ours = local;
	let theirs = params.theirs;
	for (const message of [...messages].sort((a, b) => a.cursor - b.cursor)) {
		// Our own posts carry no signal (they open under both branches by
		// construction — both derive from the state that produced them).
		if (
			params.group.messages.some((m) => m.direction === 'outbound' && m.cursor === message.cursor)
		) {
			continue;
		}
		const onOurs = await probeSealedMessage({
			state: ours,
			sealedMsg64: message.opaqueMessageBase64,
			localStablePubkey
		});
		const onTheirs = await probeSealedMessage({
			state: theirs,
			sealedMsg64: message.opaqueMessageBase64,
			localStablePubkey
		});
		ours = onOurs.state;
		theirs = onTheirs.state;
		if (onTheirs.thirdParty && !onOurs.opened) return true;
		if (onOurs.thirdParty && !onTheirs.opened) return false;
	}
	return undefined;
}

/**
 * Spec §10.3 rank for a fork between the local state and the incoming
 * document's branch: commit-point documents at the fork epoch where the chains
 * carry them (the LOWER Commit cursor wins — coordinator order read off the
 * chains), the live-document rank where a side has none.
 */
async function forkRank(params: {
	existing: StoredChatGroup;
	doc: GroupDocument;
	address?: string;
	forkEpoch: bigint;
	chain?: {
		store: BlobStore;
		addressToUrl: (a: string) => string;
		seal: Nip44Seal;
		dekPubkey: string;
	};
}): Promise<boolean> {
	const live = (d?: { address: string; cursor: number }): ForkBranchRank['live'] =>
		d ? { cursor: d.cursor, address: d.address } : undefined;
	const ours: ForkBranchRank = { live: live(params.existing.appliedDocument) };
	const theirs: ForkBranchRank = {
		live: params.address ? { cursor: params.doc.cursor, address: params.address } : undefined
	};
	// Our own Commit's cursor is the commit point (spec §10.3: the authoring
	// device knows it directly) — used where it beats any chained document.
	const own = params.existing.commitPoint;
	if (own && own.epoch === params.forkEpoch.toString()) {
		ours.commit = { cursor: own.cursor, address: '' };
	}
	if (params.chain && params.address && params.existing.appliedDocument) {
		const walk = (tipAddress: string) =>
			forkBranchCommitRank({
				tipAddress,
				groupId: params.doc.gid,
				forkEpoch: params.forkEpoch,
				...params.chain!
			});
		const [oursCommit, theirsCommit] = await Promise.all([
			walk(params.existing.appliedDocument.address),
			walk(params.address)
		]);
		if (oursCommit && (!ours.commit || oursCommit.cursor < ours.commit.cursor)) {
			ours.commit = oursCommit;
		}
		theirs.commit = theirsCommit;
	}
	return forkRankAdoptsTheirs(ours, theirs);
}

/**
 * Resolve a §10 fork between the local state and the incoming document's
 * branch (spec §10 resolution): the coordinator-order mark (self-sufficient —
 * the racing loser marked `dead` and adopts, the winner `live` and keeps), then
 * the third-party verdict, then the recorded decision / commit-point rank.
 * Keeps ours → record + surface, no state change. Adopts → the §8 forward-only
 * exception, with the decision recorded so the rank alone can never overturn it.
 */
async function resolveGroupFork(params: {
	existing: StoredChatGroup;
	localState: ClientState;
	theirs: ClientState;
	doc: GroupDocument;
	address?: string;
	forkEpoch: bigint;
	chain?: {
		store: BlobStore;
		addressToUrl: (a: string) => string;
		seal: Nip44Seal;
		dekPubkey: string;
	};
}): Promise<ReconcileOutcome> {
	const incomingFingerprint = stateFingerprint(params.theirs);
	// Step 2 runs only where the mark cannot answer — it costs a fetch + probes.
	const verdict = params.existing.branch
		? undefined
		: await thirdPartyVerdict({ group: params.existing, theirs: params.theirs });
	const decision = await decideForkResolution({
		forkEpoch: params.forkEpoch.toString(),
		incomingFingerprint,
		branch: params.existing.branch,
		verdict,
		recorded: params.existing.forkDecision,
		rank: () => forkRank({ ...params, chain: params.chain })
	});
	const winner = decision.adopt ? incomingFingerprint : stateFingerprint(params.localState);
	const forkDecision: StoredForkDecision = {
		epoch: params.forkEpoch.toString(),
		fingerprint: winner,
		by: decision.by
	};
	if (!decision.adopt) {
		// Keep ours: record + surface (spec §10 — a fork MUST be surfaced, not
		// silent) and leave the state untouched.
		replaceGroup(params.existing.id, {
			...params.existing,
			forkDecision,
			syncIssues: [
				...params.existing.syncIssues.filter((issue) => issue.cursor !== params.doc.cursor),
				{
					cursor: params.doc.cursor,
					createdAt: Date.now(),
					detail: `Fork at epoch ${params.forkEpoch} resolved: kept this device's branch (${decision.by})`
				}
			]
		});
		return 'skipped';
	}
	await fastForwardGroup(params.doc, params.address, { allowEqualEpoch: true, forkDecision });
	return 'fork-resolved';
}

async function fetchMessageGap(
	group: StoredChatGroup,
	gid: string,
	after: number
): Promise<{ cursor: number; createdAt: number; opaqueMessageBase64: string }[]> {
	const account = requireActiveAccount('You must be logged in to catch up group messages');
	const result = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
		client.FetchManyGroupMessages({
			groups: [
				{
					gid,
					after: after > 0 ? after : undefined
				}
			]
		})
	);
	return result.messages.map((m) => ({
		cursor: m.cursor,
		createdAt: m.at,
		opaqueMessageBase64: m.msg_64
	}));
}

/**
 * Chained catch-up (§8.5): replay the message gap epoch-by-epoch so messages
 * sent during the behind window are recovered (single-snapshot fast-forward
 * would lose them by MLS forward secrecy). Background, after `fastForwardGroup`
 * restored liveness; any failure leaves the fast-forwarded state (§8.5 fallback).
 *
 * Sibling-Commits skip (shared-leaf guard) and the next chain step bridges the
 * epoch. Catch-up is pure message recovery — the persisted state stays the
 * fast-forward's tip; no regression.
 */
async function catchUpGroupFromChain(params: {
	groupId: string;
	localEpoch: bigint;
	localStateBase64: string;
	decryptFrontier: number;
	groupAddress: string;
	pointer: TipPointer;
	dekSeal: Nip44Seal;
	dekPubkey: string;
	config: MultiDeviceOwnerConfig | undefined;
}): Promise<void> {
	const group = getChatGroup(params.groupId);
	if (!group) return; // vanished (soft-deleted) mid-flight
	const gid = getProtocolGroupId(decodeStoredGroupState(group));

	// 1+2 (concurrent, spec §8.5 steps 1–2): walk the `prev` chain and fetch the
	// whole gap (messages after the decrypt frontier) AT THE SAME TIME — both
	// depend only on the tip address + local frontier, and the chain's sole job
	// is partitioning the gap for replay, which happens after both. This takes
	// one coordinator RTT off every catching-up group's critical path
	// (max(walk, gap) instead of walk + gap). Failure semantics unchanged from
	// the sequential order: either leg failing returns with liveness preserved
	// by the fast-forward. The sentinel-style catch also keeps an early walk
	// return from leaving an unhandled gap rejection behind.
	const gapPromise = fetchMessageGap(group, gid, params.decryptFrontier).catch((error) => {
		dbg('catchUp gap fetch failed; fast-forward preserved liveness', {
			gid: params.groupId,
			error: errorMessage(error)
		});
		return null;
	});
	let chain: ChainStep[];
	try {
		chain = await walkGroupChain({
			tipAddress: params.groupAddress,
			groupId: gid,
			localEpoch: params.localEpoch,
			store: makeReadStore(readServers(params.pointer, params.config)),
			addressToUrl: (a) => urlFromTip(a, params.pointer),
			seal: params.dekSeal,
			dekPubkey: params.dekPubkey
		});
	} catch (error) {
		dbg('catchUp walk failed; fast-forward preserved liveness', {
			gid: params.groupId,
			error: errorMessage(error)
		});
		return;
	}
	if (chain.length === 0) {
		dbg('catchUp empty chain', { gid: params.groupId });
		return;
	}
	const gap:
		| {
				cursor: number;
				createdAt: number;
				opaqueMessageBase64: string;
		  }[]
		| null = await gapPromise;
	if (!gap || gap.length === 0) {
		dbg('catchUp no gap to replay', { gid: params.groupId, steps: chain.length });
		return;
	}

	dbg('catchUp replaying', { gid: params.groupId, steps: chain.length, gap: gap.length });

	// 3. Per-range replay. states[0] = local (s0); states[i>0] = chain[i-1].
	//    Each epoch's messages decrypt with that epoch's gen-0 ClientState;
	//    sibling-Commits skip (shared-leaf guard) and the next step bridges.
	//    mdActive so any partition imperfection skips instead of poisoning. ONE
	//    working session accumulates recovered messages across ranges.
	//
	//    The replay is bounded at the tip document's cursor (spec §8.5 partition
	//    invariant): catch-up owns (decryptFrontier, tipDoc.cursor]; the live
	//    delivery stream owns (tipDoc.cursor, ∞). Messages past the tip cursor
	//    are at the tip epoch and the live path both stores AND ratchets them.
	//    Merging them here first would trip live ingestion's cursor dedup
	//    (seenCursors) and silently skip ratcheting them — leaving the shared
	//    leaf's ratchet behind under a current-looking cursor, so every
	//    subsequent send from this device fails on siblings ("Desired gen in
	//    the past"). The tip state is therefore never used for replay.
	const account = requireActiveAccount('You must be logged in to catch up group messages');
	const workingGroup = createWorkingChatGroupSession(
		group,
		decodeClientStateBase64(params.localStateBase64)
	);
	workingGroup.fetchCursor = params.decryptFrontier;
	const states = [params.localStateBase64, ...chain.map((s) => s.clientState)];
	const boundaries = [params.decryptFrontier, ...chain.map((s) => s.cursor)];
	const ranges = partitionGapByEpoch(gap, boundaries);
	for (let i = 0; i < ranges.length; i++) {
		const range = ranges[i]!;
		if (range.messages.length === 0) continue;
		workingGroup.state = decodeClientStateBase64(states[i]!);
		await ingestChatGroupMessages({
			group: workingGroup,
			messages: range.messages,
			localStablePubkey: normalizePubKey(account.pubkey),
			mdActive: true
		});
	}

	// 4. Merge recovered messages into the latest snapshot (live delivery may
	//    have advanced the group while catch-up ran). Dedup by cursor; keep the
	//    current state/fetchCursor (tip + live). Catch-up never touches state.
	//    The read-merge-write runs inside the per-group lock so it cannot clobber
	//    (nor be clobbered by) a concurrent live-delivery cycle on the same group.
	await runGroupOperation(params.groupId, async () => {
		const current = getChatGroup(params.groupId);
		if (!current) return; // vanished
		const have = new Set(current.messages.map((m) => m.cursor));
		const recovered = workingGroup.messages.filter((m) => !have.has(m.cursor));
		if (recovered.length === 0) {
			dbg('catchUp no new messages (already current)', { gid: params.groupId });
			return;
		}
		const issueHave = new Set(current.syncIssues.map((i) => i.cursor));
		const mergedIssues = [
			...current.syncIssues,
			...workingGroup.syncIssues.filter((i) => !issueHave.has(i.cursor))
		];
		replaceGroup(params.groupId, {
			...current,
			messages: [...current.messages, ...recovered].sort((a, b) => a.cursor - b.cursor),
			syncIssues: mergedIssues.slice(-50)
		});
		dbg('catchUp done', {
			gid: params.groupId,
			recovered: recovered.length,
			total: current.messages.length + recovered.length
		});
	});
}

/**
 * Soft-delete a group (spec §8/§10 tombstone). Drops the local group, records
 * its `{gid, epoch}` tombstone on the owner config so the next re-publish
 * carries it in the `removed` union (§10.5), and fires the re-publish hook so
 * siblings converge. Soft-delete stops devices *tracking* a group; it is not an
 * MLS Leave (§13). The tombstone is cleared from the config once published.
 *
 * The local group is dropped regardless of whether multi-device is enabled;
 * the tombstone only propagates when enabled.
 */
export async function softDeleteGroup(groupId: string): Promise<Tombstone> {
	const group = getChatGroup(groupId);
	if (!group) throw new Error(`Cannot soft-delete: group ${groupId} not found`);
	const state = decodeStoredGroupState(group);
	const tombstone: Tombstone = {
		gid: getProtocolGroupId(state),
		epoch: Number(state.groupContext.epoch)
	};
	// Drop the local group. The watch driver reconciles its watch set against
	// the store, so removing it here unwatches it (no parallel unwatch needed).
	deleteChatGroup(groupId);
	dbg('softDeleteGroup dropped local', tombstone);

	// Append the tombstone + publish atomically on the serialized lane so a
	// concurrent meta publish can't clear `pendingTombstones` between the append
	// and the republish (§10.5: a deletion must stick across the fleet).
	runSerialized(async () => {
		const cfg = getMultiDeviceConfig();
		if (!cfg) return;
		cfg.pendingTombstones = [...(cfg.pendingTombstones ?? []), tombstone];
		saveConfig(cfg);
		await publish({ resealGroups: [], resealMeta: true });
	});
	return tombstone;
}

// ---------------------------------------------------------------------------
// Device-link bootstrap (spec §11)
// ---------------------------------------------------------------------------

export interface LinkResult {
	seeded: number;
	fastForwarded: number;
	skipped: number;
	dropped: number;
}

/**
 * Link this device from a connection string: persist the ephemeral key + relays
 * + `d` as the active config, subscribe to the tip, and seed/reconcile from the
 * first document. The caller (UI) shows progress; this resolves once the first
 * reconcile completes. Requires the active account to be the same identity that
 * minted the string (the seal is to that owner npub).
 */
export async function linkDeviceFromConnectionString(connection: string): Promise<LinkResult> {
	if (!browser) throw new Error('Multi-device can only run in the browser');
	const account = manager.getActive();
	if (!account) throw new Error('Log in to link a device');
	// Probe before importing anything: the tip is NIP-44-sealed to the owner
	// (§6), so a signer without nip44 would decrypt nothing and surface the
	// failure as "0 groups seeded" with no error anywhere.
	if (!account.nip44) {
		throw new Error('This signer does not support NIP-44 v2 — multi-device sync needs it');
	}
	const payload = parseConnectionString(connection);
	const decoded = nip19.decode(payload.naddr);
	if (decoded.type !== 'naddr') throw new Error('Invalid connection string');
	const naddr = decoded.data;
	// Persist the inherited config (relays + ephemeral key + d), enabled.
	const config: MultiDeviceOwnerConfig = {
		ownerPubkey: normalizePubKey(account.pubkey),
		dTag: naddr.identifier,
		ephemeralPrivateKey: payload.ephemeralPrivateKey,
		ephemeralPubkey: naddr.pubkey,
		relays: naddr.relays?.length ? naddr.relays : DEFAULT_MULTI_DEVICE_RELAYS,
		// ponytail: inherit the default 3-host replication rather than the source's
		// full list — the read path tries them in order and the user can expand.
		blossomServers: DEFAULT_BLOSSOM_SERVERS
	};
	saveConfig(config);

	// Fetch the current tip, then the document, then reconcile. Surface progress
	// for this user-initiated link — handleTipEvent + applyTip populate the
	// group-loading total + counter while mdProgress stays active.
	const ownerPubkey = normalizePubKey(account.pubkey);
	setMdProgress('Fetching device state');
	try {
		const tipEvent = await fetchLatestTipEvent(config);
		let result: LinkResult = { seeded: 0, fastForwarded: 0, skipped: 0, dropped: 0 };
		if (tipEvent) {
			const reconciled = await handleTipEvent(tipEvent, ownerPubkey);
			if (reconciled) {
				result = {
					seeded: reconciled.seeded,
					fastForwarded: reconciled.fastForwarded,
					skipped: reconciled.skipped,
					dropped: reconciled.dropped
				};
			}
		}
		// Live subscription reconciles on every subsequent tip move (spec §6).
		startTipSubscription();
		// Mark the session reconciled: link just applied the tip directly, so the
		// watch's §10.6 gate (awaitMultiDeviceReconciled) should not re-run it.
		mdReconcilePromise = Promise.resolve();
		return result;
	} finally {
		clearMdProgress();
	}
}

/** Fetch the latest (greatest created_at) tip event for a config. */
async function fetchLatestTipEvent(
	config: MultiDeviceOwnerConfig,
	timeoutMs = 5000
): Promise<NostrEvent | null> {
	let latest: NostrEvent | null = null;
	await new Promise<void>((resolve) => {
		// `request` is the one-off fetch (auto-retry on connection errors, completes
		// on EOSE). Collect the greatest `created_at` within the cap; the live
		// subscription (startTipSubscription) handles ongoing convergence if this
		// fetch is slow or incomplete.
		const sub = relayPool
			.request(
				config.relays,
				{
					kinds: [MULTI_DEVICE_TIP_KIND],
					authors: [config.ephemeralPubkey],
					'#d': [config.dTag]
				},
				{ reconnect: 1, timeout: timeoutMs }
			)
			.subscribe({
				next: (event) => {
					if (!latest || event.created_at > latest.created_at) latest = event;
				},
				complete: () => resolve(),
				error: () => resolve()
			});
		// ponytail: hard cap in case `request` neither completes nor errors.
		setTimeout(() => {
			try {
				sub.unsubscribe();
			} catch {
				/* best-effort */
			}
			resolve();
		}, timeoutMs + 500);
	});
	return latest;
}

// (ReconcileOutcome is internal to the reconcile target; not re-exported.)
