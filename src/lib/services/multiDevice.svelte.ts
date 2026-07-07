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
import { browser } from '$app/environment';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';

import { manager } from '$lib/services/accountManager.svelte';
import { relayPool } from '$lib/services/relay-pool';
import { eventStore } from '$lib/services/eventStore';
import { mapEventsToStore } from 'applesauce-core/observable';
import {
	uploadBlob,
	fetchBlob,
	type BlossomSigner,
	type UploadedBlob
} from '$lib/services/chatBlossomClient';
import { BLOSSOM_SERVERS } from '$lib/constants/chat';
import {
	listChatGroups,
	getChatGroup,
	importChatGroups,
	replaceGroup,
	deleteChatGroup,
	decodeStoredGroupState,
	reloadChatGroupsForOwner,
	runGroupOperation,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import { markCoordinatorUsed } from '$lib/services/chatCoordinators.svelte';
import { getProtocolGroupId } from '$lib/services/chatGroupLifecycle.svelte';
import { requireActiveAccount, withCoordinatorClient } from '$lib/services/chatRuntime';
import { ingestChatGroupMessages } from '$lib/services/chatGroupMessages.svelte';
import { createWorkingChatGroupSession } from '$lib/services/chatGroupSessions.svelte';
import { normalizePubKey } from '$lib/utils';
import { base64ToBytes, clientStateDecoder, type ClientState } from 'ts-mls';
import {
	MultiDeviceError,
	publishGroupDocument,
	publishMetaDocument,
	pullDocument,
	reconcileMetaDocument,
	composeTombstoneUnion,
	groupEpoch,
	groupMetadata,
	walkGroupChain,
	type Nip44Seal,
	type BlobStore,
	type GroupDocument,
	type GroupSnapshot,
	type MetaDocument,
	type Tombstone,
	type ReconcileTarget,
	type ReconcileOutcome,
	type ChainStep
} from '$lib/services/multiDevice';
import {
	getLastResortKeyPackageEntry,
	loadLastResortKeyPackage
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
	'https://blossom.primal.net/',
	'https://cdn.hzrd149.com/',
	'https://blossom.ditto.pub/'
];

/**
 * Dev-phase debug log. Filter the console by `[multi-device]` to trace the
 * enable/disable → save → publish → reconcile flow. Remove before shipping.
 */
function dbg(label: string, detail?: unknown): void {
	if (!browser) return;
	console.debug('[multi-device]', label, detail ?? '');
}

/** Per-owner multi-device config. Keyed by owner pubkey in localStorage. */
export interface MultiDeviceOwnerConfig {
	/** Stable opaque `d` for the replaceable tip event. Generated once. */
	dTag: string;
	/** Ephemeral signing key for the outer tip event + Blossom auth (hex nsec). */
	ephemeralPrivateKey: string;
	/** Derived once from `ephemeralPrivateKey`. */
	ephemeralPubkey: string;
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
	 * Dev-mode tip transition log (newest first, capped at 20). One entry per
	 * tip move that actually changed ≥1 address — recorded in `setLastSeenTip`,
	 * the single chokepoint both read and write paths route through. Pure
	 * visibility; never read by sync logic.
	 */
	tipHistory?: TipTransition[];
	/**
	 * Own soft-delete tombstones awaiting publish (§10.5 union). Cleared after a
	 * successful publish; refilled by `softDeleteGroup`. Adopted peer tombstones
	 * aren't stored — re-adopted from the tip on every reconcile-before-push.
	 */
	pendingTombstones?: Tombstone[];
	/** Whether sync is active. When false, no publishing, no subscription. */
	enabled: boolean;
	/** Whether this device minted the document (source) or adopted it (linked). Defaults to 'source' for legacy configs. */
	role?: 'source' | 'linked';
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
	const cfg = readAllConfigs()[normalizePubKey(owner)];
	// ponytail: legacy configs predate the `role` field; assume source (the
	// original minter) rather than persist a migration.
	return cfg ? { ...cfg, role: cfg.role ?? 'source' } : undefined;
}

/** Whether multi-device sync is on for the active (or given) owner. */
export function isMultiDeviceActive(ownerPubkey?: string): boolean {
	return !!getMultiDeviceConfig(ownerPubkey)?.enabled;
}

function saveConfig(config: MultiDeviceOwnerConfig): void {
	if (!browser) return;
	const owner = manager.getActive()?.pubkey;
	if (!owner) return;
	const all = readAllConfigs();
	all[normalizePubKey(owner)] = config;
	writeAllConfigs(all);
	dbg('saveConfig', {
		owner: owner.slice(0, 8),
		enabled: config.enabled,
		dTag: config.dTag.slice(0, 8)
	});
}

/** Random opaque `d`, generated once per identity (spec §6). */
function generateDTag(): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Build a fresh config (new ephemeral key + `d`), inheriting default relays. */
function createFreshConfig(
	relays: string[] = DEFAULT_MULTI_DEVICE_RELAYS,
	blossomServers: string[] = DEFAULT_BLOSSOM_SERVERS
): MultiDeviceOwnerConfig {
	const sk = generateSecretKey();
	const ephemeralPrivateKey = bytesToHex(sk);
	const ephemeralPubkey = getPublicKey(sk);
	return {
		dTag: generateDTag(),
		ephemeralPrivateKey,
		ephemeralPubkey,
		relays,
		blossomServers,
		enabled: true,
		role: 'source'
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
	dbg('enableMultiDevice enter', { hadAccount: !!account, relayCount: relays?.length ?? 0 });
	const existing = getMultiDeviceConfig(account.pubkey);
	const config = existing ?? createFreshConfig(relays, blossomServers);
	if (relays && relays.length) config.relays = relays;
	if (blossomServers && blossomServers.length) config.blossomServers = blossomServers;
	config.enabled = true;
	saveConfig(config);
	dbg('enableMultiDevice done', { dTag: config.dTag.slice(0, 8), enabled: config.enabled });
	// Spec §11: the connection string is only usable once documents + a tip exist.
	// Publish every local group document + the meta document + the tip in one shot
	// so the string is live (the hooks otherwise only fire on new-group/own-commit).
	scheduleRepublish({ resealGroups: 'all', resealMeta: true });
	// Open the live tip subscription + adopt any peer state: a mid-session
	// enable is not cold start (so §10.6 ordering doesn't strictly apply), but we
	// still reconcile once so the enabling device catches up to siblings, and the
	// idempotent starter opens the subscription for ongoing convergence.
	void awaitMultiDeviceReconciled();
	return config;
}

/** Disable sync (stops publishing + subscription). Keeps the config for re-enable. */
export function disableMultiDevice(): void {
	dbg('disableMultiDevice enter');
	const config = getMultiDeviceConfig();
	if (config) {
		config.enabled = false;
		saveConfig(config);
	}
	resetMultiDeviceSession();
}

/** Rotate the ephemeral keypair + `d` together (spec §11). All devices must re-link. */
export function rotateMultiDeviceKey(
	relays?: string[],
	blossomServers?: string[]
): MultiDeviceOwnerConfig {
	if (!browser) throw new Error('Multi-device can only run in the browser');
	const account = manager.getActive();
	if (!account) throw new Error('Log in to rotate the multi-device key');
	const existing = getMultiDeviceConfig(account.pubkey);
	const fresh = createFreshConfig(
		relays ?? existing?.relays,
		blossomServers ?? existing?.blossomServers
	);
	saveConfig(fresh);
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
 * Adapt the active account's `nip44` capability to the `Nip44Seal` interface.
 * Returns undefined if the account signer doesn't expose nip44 (some signers
 * can't). The seal is always to the owner's own npub (spec §7).
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
	const ownerPubkey = normalizePubKey(account.pubkey);
	const accountNip44 = account.nip44;
	return {
		ownerPubkey,
		seal: {
			encrypt: (pubkey, plaintext) => accountNip44.encrypt(pubkey, plaintext),
			decrypt: (pubkey, ciphertext) => accountNip44.decrypt(pubkey, ciphertext)
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

// ---------------------------------------------------------------------------
// Tip transport (spec §6)
// ---------------------------------------------------------------------------

/** Build the owner-signed inner event listing the document inventory (spec §6). */
async function buildInnerTipEvent(params: {
	pointer: TipPointer;
	ownerPubkey: string;
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

interface TipGroupPointer {
	/** Group document content address (spec §6 `x` tagged `group`). */
	address: string;
	/** Delivery group id the document is for — enables fetch-only-changed. */
	gid: string;
}

interface TipPointer {
	/** One pointer per live group document (spec §6: `['x', h, 'group', gid]`). */
	groups: TipGroupPointer[];
	/** Meta document content address, if any (spec §6: `['x', h, 'meta']`). */
	metaAddress?: string;
	/** Ordered Blossom server URLs hosting the blobs (spec §6 `server`). */
	servers: string[];
}

/** Parse + verify an outer tip event into the document inventory it carries. */
async function parseTipEvent(outer: NostrEvent, ownerPubkey: string): Promise<TipPointer | null> {
	if (outer.kind !== MULTI_DEVICE_TIP_KIND) return null;
	const { seal } = getActiveNip44Seal() ?? {};
	if (!seal) return null;
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
	for (const tag of inner.tags) {
		if (tag[0] !== 'x') continue;
		if (tag[2] === 'group' && typeof tag[1] === 'string' && typeof tag[3] === 'string') {
			groups.push({ address: tag[1], gid: tag[3] });
		} else if (tag[2] === 'meta' && typeof tag[1] === 'string') {
			metaAddress = tag[1];
		}
	}
	const servers = inner.tags
		.filter((t) => t[0] === 'server')
		.map((t) => t[1])
		.filter((s): s is string => typeof s === 'string');
	if (groups.length === 0 && metaAddress === undefined) return null;
	return { groups, metaAddress, servers };
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
	const inner = await buildInnerTipEvent({ pointer, ownerPubkey });
	dbg('tip inner owner-signed', {
		groups: pointer.groups.length,
		meta: !!pointer.metaAddress
	});
	const { seal } = getActiveNip44Seal() ?? {};
	if (!seal) throw new Error('Active account cannot NIP-44 seal (signer lacks nip44)');
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
 * a no-op when multi-device is disabled. Wired at group creation and on
 * locally-authored Commit self-echo confirmation.
 */
export function onGroupStateAdvance(gid: string): void {
	if (!browser) return;
	const config = getMultiDeviceConfig();
	if (!config?.enabled) return;
	dbg('onGroupStateAdvance', { gid: gid.slice(0, 8), dTag: config.dTag.slice(0, 8) });
	scheduleRepublish({ resealGroups: [gid], resealMeta: false });
}

/**
 * Re-publish hook for an identity-level change (spec §10.5): a soft-delete
 * tombstone or a last-resort key-package publish/rotate. Publishes only the
 * meta document and updates only its `meta` `x` tag. Fire-and-forget.
 */
export function onMetaStateChange(): void {
	if (!browser) return;
	const config = getMultiDeviceConfig();
	if (!config?.enabled) return;
	dbg('onMetaStateChange', { dTag: config.dTag.slice(0, 8) });
	scheduleRepublish({ resealGroups: [], resealMeta: true });
}

/** An empty tip pointer (used when the fetched tip parses to nothing). */
function emptyTipPointer(config: MultiDeviceOwnerConfig): TipPointer {
	return { groups: [], servers: config.blossomServers };
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
	const parsed = await parseTipEvent(tipEvent, ownerPubkey);
	return { pointer: parsed ?? emptyTipPointer(config), deferred: false };
}

/** gids of a tombstone list — for the §4.3 invariant (a `gid` is in `x` XOR `removed`). */
function tombstoneGids(tombstones: Tombstone[]): Set<string> {
	return new Set(tombstones.map((t) => t.gid));
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
			metaChanged
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
 * Build the tip's group inventory (§4.3): start from the fetched tip's slots
 * (peer addresses), drop tombstoned gids, then overlay the freshly re-sealed
 * addresses. A re-sealed gid absent from the fetched tip (newly created, or a
 * stale peer tip) is added. §4.3 is enforced here, once, for every publish.
 */
function buildInventory(
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

/**
 * Ingestion chokepoint (§6 + §8): reconcile only documents whose address
 * changed vs `lastSeenTip`. Shared by the read path (`handleTipEvent`) and the
 * write path (`publish`). Does NOT write `lastSeenTip` — the caller records it.
 */
async function applyTip(
	pointer: TipPointer,
	ctx: { seal: Nip44Seal; ownerPubkey: string; config: MultiDeviceOwnerConfig }
): Promise<{ adoptedTombstones: Tombstone[]; counts: ReconcileCounts }> {
	const { seal, ownerPubkey, config } = ctx;
	const lastSeen = config.lastSeenTip;
	const counts: ReconcileCounts = {
		seeded: 0,
		fastForwarded: 0,
		skipped: 0,
		dropped: 0,
		ignored: 0
	};
	let adoptedTombstones: Tombstone[] = [];

	for (const group of pointer.groups) {
		const lastSeenGroup = lastSeen?.groups.find((g) => g.gid === group.gid);
		if (lastSeenGroup?.address === group.address) continue;
		dbg('applyTip group changed', { gid: group.gid, address: group.address.slice(0, 12) });
		try {
			const { outcome } = await pullAndReconcileGroup(group, pointer, seal, ownerPubkey, config);
			if (outcome === 'seeded') counts.seeded++;
			else if (outcome === 'fast-forwarded') counts.fastForwarded++;
			else counts.skipped++;
		} catch (error) {
			dbg('applyTip group reconcile failed', { gid: group.gid, error });
		}
	}

	if (pointer.metaAddress && pointer.metaAddress !== lastSeen?.metaAddress) {
		dbg('applyTip meta changed', { address: pointer.metaAddress.slice(0, 12) });
		try {
			const { doc, counts: metaCounts } = await pullAndReconcileMeta(
				pointer,
				seal,
				ownerPubkey,
				config
			);
			adoptedTombstones = doc.removed ?? [];
			counts.dropped += metaCounts.dropped;
			counts.ignored += metaCounts.ignored;
		} catch (error) {
			dbg('applyTip meta reconcile failed', { error });
		}
	}

	return { adoptedTombstones, counts };
}

/**
 * The one §10.5 procedure: reconcile the full doc set, then publish only the
 * affected document(s) and rewrite the tip. `plan` picks what to re-seal
 * (group change → that group; meta change → meta; enable/server → all). §4.3
 * is enforced once in `buildInventory`.
 */
async function publish(plan: PublishPlan): Promise<void> {
	const config = getMultiDeviceConfig();
	if (!config?.enabled) return;
	const active = getActiveNip44Seal();
	if (!active) return;
	const { seal, ownerPubkey } = active;
	const { pointer, deferred } = await fetchTipForPublish(config, ownerPubkey);
	if (deferred) return;

	// §10.5 reconcile-before-push: full document set, delta-gated by lastSeenTip.
	const { adoptedTombstones, counts } = await applyTip(pointer, { seal, ownerPubkey, config });
	const writeStore = makeBlossomStore(ephemeralSigner(config));

	// The published `removed` set (own pending + adopted, XOR'd vs the live
	// inventory per §4.3) drives both the meta doc and the tip's group filter.
	const liveSnapshots = collectGroupSnapshots();
	const removed = composeTombstoneUnion(
		config.pendingTombstones ?? [],
		adoptedTombstones,
		liveSnapshots.map((s) => s.gid)
	);
	const tombstonedGids = tombstoneGids(removed);

	// Re-seal the affected group documents (§10.5 publishing unit).
	const resealed: TipGroupPointer[] = [];
	const gidsToReseal =
		plan.resealGroups === 'all' ? liveSnapshots.map((s) => s.gid) : plan.resealGroups;
	for (const gid of gidsToReseal) {
		const snapshot = liveSnapshots.find((s) => s.gid === gid);
		if (!snapshot) continue; // gone (tombstoned/deleted) since the trigger fired
		const prev = pointer.groups.find((g) => g.gid === gid)?.address;
		const result = await publishGroupDocument({
			group: snapshot,
			seal,
			ownerPubkey,
			store: writeStore,
			prev
		});
		resealed.push({ address: result.address, gid });
		dbg('publish group doc', { gid, address: result.address.slice(0, 12) });
	}

	// Re-seal the meta document (tombstones + last-resort key package) only when asked.
	let metaAddress = pointer.metaAddress;
	if (plan.resealMeta) {
		const result = await publishMetaDocument({
			seal,
			ownerPubkey,
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

	// Own tombstones are now in the immutable published meta doc; clear pending.
	if (plan.resealMeta) {
		config.pendingTombstones = [];
		saveConfig(config);
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

/** Snapshot every active local group (spec §4 — the live inventory). */
function collectGroupSnapshots(): GroupSnapshot[] {
	const groups: GroupSnapshot[] = [];
	for (const group of listChatGroups()) {
		if (group.status && group.status !== 'active') continue;
		const state = decodeStoredGroupState(group);
		groups.push({
			gid: getProtocolGroupId(state),
			state,
			coordinatorKey: group.coordinatorKey,
			fetchCursor: group.fetchCursor
		});
	}
	return groups;
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

/**
 * Subscribe to the tip replaceable event for the active owner's config and
 * reconcile on every change. Idempotent: re-subscribing tears down the prior
 * subscription first. No-op when disabled.
 */
function startTipSubscription(): void {
	if (!browser) return;
	const config = getMultiDeviceConfig();
	if (!config?.enabled) return;
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
	if (!config?.enabled) return Promise.resolve();
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
}

/** Tear down the session: clear the reconcile promise + stop the tip
 * subscription. Called on account change + disable so the next start
 * re-reconciles for the new owner. */
export function resetMultiDeviceSession(): void {
	mdReconcilePromise = null;
	stopTipSubscription();
}

/** Manual one-shot reconcile (diagnostic / recovery). Fetches the tip +
 * reconciles (§8), bypassing the in-session dedup so a repeat click always
 * re-applies. Used by the config-page "Re-sync now" action. No-op when sync is
 * off / no account; does not start the live subscription. */
export async function reconcileMultiDeviceNow(): Promise<ReconcileCounts | null> {
	if (!browser) return null;
	const config = getMultiDeviceConfig();
	if (!config?.enabled) return null;
	const account = manager.getActive();
	if (!account) return null;
	const ownerPubkey = normalizePubKey(account.pubkey);
	dbg('reconcileMultiDeviceNow enter', { dTag: config.dTag.slice(0, 8) });
	const tipEvent = await fetchLatestTipEvent(config);
	if (!tipEvent) {
		dbg('reconcileMultiDeviceNow no tip found');
		return null;
	}
	// Bypass the per-doc + per-event dedup: a manual trigger should always
	// re-apply, even if the tip address/event id matches the last auto-reconcile.
	config.lastSeenTip = undefined;
	config.lastSeenTipEventId = undefined;
	saveConfig(config);
	const counts = await handleTipEvent(tipEvent, ownerPubkey);
	dbg('reconcileMultiDeviceNow done', { counts });
	return counts;
}

/** Reconcile outcome counts surfaced to callers (UI / link flow / logs). */
export interface ReconcileCounts {
	seeded: number;
	fastForwarded: number;
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
			let lastError: unknown;
			for (const server of clean) {
				try {
					return await fetchBlob(`${server}/${address}`);
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError instanceof Error
				? new Error(`Could not fetch document: ${lastError.message}`)
				: new Error('Could not fetch document');
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
	seal: Nip44Seal,
	ownerPubkey: string,
	config: MultiDeviceOwnerConfig | undefined
): Promise<{ doc: GroupDocument; outcome: ReconcileOutcome }> {
	const store = makeReadStore(readServers(pointer, config));
	const doc = await pullDocument({
		address: group.address,
		store,
		addressToUrl: (a) => urlFromTip(a, pointer),
		seal,
		ownerPubkey
	});
	if (doc.type !== 'group') {
		throw new MultiDeviceError('Tip group tag pointed at a non-group document');
	}
	const outcome = await makeReconcileTarget(ownerPubkey, {
		groupAddress: group.address,
		pointer,
		seal,
		config
	}).applyGroupDocument(doc);
	if (outcome === 'seeded') {
		// Seeding changes the group set; refresh the in-memory store.
		await reloadChatGroupsForOwner(ownerPubkey);
	}
	return { doc, outcome };
}

/** Pull the meta document from the tip and reconcile tombstones + key package. */
async function pullAndReconcileMeta(
	pointer: TipPointer,
	seal: Nip44Seal,
	ownerPubkey: string,
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
		seal,
		ownerPubkey
	});
	if (doc.type !== 'meta') {
		throw new MultiDeviceError('Tip meta tag pointed at a non-meta document');
	}
	const result = await reconcileMetaDocument(makeReconcileTarget(ownerPubkey), doc);
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
	const { seal } = getActiveNip44Seal() ?? {};
	if (!seal) return null;
	const config = getMultiDeviceConfig();
	// §10.5 tip-address check: an event id we've already processed is our own
	// self-echo (publish loopback) or a duplicate relay delivery — skip without
	// parsing or fetching. This is the cheap dedup layer above the per-doc
	// address delta.
	if (config?.lastSeenTipEventId === outer.id) return null;
	const pointer = await parseTipEvent(outer, ownerPubkey);
	if (!pointer) return null;
	if (!config) return null;

	dbg('handleTipEvent', {
		groups: pointer.groups.length,
		meta: !!pointer.metaAddress,
		cold: !config.lastSeenTip
	});

	// Ingest via the shared chokepoint (same reconcile the write path runs before
	// every push), then record the peer tip as the last-seen one.
	const { counts } = await applyTip(pointer, { seal, ownerPubkey, config });
	setLastSeenTip(config, pointer, outer.id, { source: 'read', counts });

	dbg('handleTipEvent done', { counts });
	// ponytail: do not auto-republish on read (spec §8 SHOULD). The next local
	// advance republishes; republishing here risks a publish loop across devices.
	return counts;
}

/**
 * Build a `ReconcileTarget` over the live group store. Seed installs a new
 * `StoredChatGroup`; fast-forward replaces state+cursor only at a strictly newer
 * epoch (§8); tombstones drop a group whose epoch ≤ the tombstone (§8, anti-
 * downgrade).
 */
function makeReconcileTarget(
	ownerPubkey: string,
	catchUp?: {
		groupAddress: string;
		pointer: TipPointer;
		seal: Nip44Seal;
		config: MultiDeviceOwnerConfig | undefined;
	}
): ReconcileTarget {
	return {
		localEpoch(gid) {
			const group = getChatGroup(gid);
			if (!group) return undefined;
			return decodeStoredGroupState(group).groupContext.epoch;
		},
		async applyGroupDocument(doc) {
			const existing = getChatGroup(doc.gid);
			if (!existing) {
				await seedGroup(doc, ownerPubkey);
				return 'seeded';
			}
			const incomingEpoch = groupEpoch(doc);
			const localEpoch = decodeStoredGroupState(existing).groupContext.epoch;
			// Forward-only epoch check (spec §8) — the rollback defense.
			if (incomingEpoch === undefined || incomingEpoch <= localEpoch) {
				return 'skipped';
			}
			// Capture the pre-fast-forward decrypt frontier + local state. fast-forward
			// advances both to the tip, so the chained catch-up (spec §8.5) needs the
			// values from BEFORE it ran to know where the lossless gap starts and
			// what state decrypts range 0.
			const decryptFrontier = existing.fetchCursor;
			const localStateBase64 = existing.stateBase64;
			await fastForwardGroup(doc); // liveness first (locked CAS write)
			// Background lossless recovery (§8.5): replay the message gap epoch-by-epoch
			// so messages sent during the behind window aren't lost. Fire-and-forget —
			// fast-forward already restored liveness. Skipped when the decrypt frontier
			// is already at the adopted cursor: an online device sibling-skipped the
			// Commit on the stream, so there's no gap to recover (saves the chain walk
			// + gap fetch on every online sibling-Commit fast-forward).
			if (catchUp && decryptFrontier < doc.cursor) {
				void catchUpGroupFromChain({
					groupId: doc.gid,
					localEpoch,
					localStateBase64,
					decryptFrontier,
					groupAddress: catchUp.groupAddress,
					pointer: catchUp.pointer,
					seal: catchUp.seal,
					config: catchUp.config,
					ownerPubkey
				}).catch((error) =>
					dbg('catchUp failed; fast-forward preserved liveness', {
						gid: doc.gid,
						error: error instanceof Error ? error.message : String(error)
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
		},
		getLastResortKeyPackage() {
			return getLastResortKeyPackageEntry();
		}
	};
}

/** Seed a missing group from a group document (spec §9). */
async function seedGroup(doc: GroupDocument, ownerPubkey: string): Promise<void> {
	// ponytail: joinEpoch 0 — seeded groups adopt the writer's current state via
	// clientState, so there's no pre-membership boundary to filter (spec §9).
	const seeded: StoredChatGroup = {
		id: doc.gid,
		ownerPubkey,
		coordinatorKey: doc.coordinator,
		createdAt: Date.now(),
		stateBase64: doc.clientState,
		lastCursor: doc.cursor,
		fetchCursor: doc.cursor,
		messages: [],
		syncIssues: [],
		snapshots: [],
		metadata: groupMetadata(doc),
		joinEpoch: 0n,
		status: 'active'
	};
	await importChatGroups([seeded]);
	dbg('seedGroup', { gid: doc.gid.slice(0, 8), epoch: String(groupEpoch(doc)) });
	// Establish the coordinator relationship so it appears in the coordinator list
	// and operational queries (available key packages, welcomes) — mirrors the
	// create/join seam. Idempotent if the coordinator is already known.
	markCoordinatorUsed(doc.coordinator);
}

/**
 * Fast-forward a group to a strictly newer epoch (§8). Runs under the per-group
 * lock (`runGroupOperation`) so it can't clobber (nor be clobbered by) a
 * concurrent live-delivery cycle — both mutate the same record. Re-reads +
 * re-checks the epoch UNDER the lock (CAS): a watch cycle may have caught up
 * while we waited, in which case this is a no-op.
 */
async function fastForwardGroup(doc: GroupDocument): Promise<void> {
	await runGroupOperation(doc.gid, async () => {
		const existing = getChatGroup(doc.gid);
		if (!existing) return; // vanished (soft-deleted) while waiting for the lock
		const incomingEpoch = groupEpoch(doc);
		const localEpoch = decodeStoredGroupState(existing).groupContext.epoch;
		// Re-check under the lock (CAS): a concurrent cycle may have caught up.
		if (incomingEpoch === undefined || incomingEpoch <= localEpoch) return;
		replaceGroup(existing.id, {
			...existing,
			stateBase64: doc.clientState,
			metadata: groupMetadata(doc),
			coordinatorKey: doc.coordinator,
			// Cursor advances to the document's (the adopted state processed through it).
			fetchCursor: Math.max(existing.fetchCursor, doc.cursor),
			lastCursor: Math.max(existing.lastCursor, doc.cursor),
			// The adopted state is authoritative (owner-signed, content-addressed), so
			// clear any transient poisoning from the stale-state ingestion window — an
			// ahead-of-local-epoch message the device couldn't decrypt before this
			// fast-forward arrived. Removal is a genuine MLS event, not transient, so
			// it is left intact (spec §8).
			...(existing.status === 'poisoned'
				? { status: 'active' as const, poisonedAtCursor: undefined }
				: {})
		});
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
async function fetchMessageGap(
	group: StoredChatGroup,
	gid: string,
	after: number
): Promise<
	{ cursor: number; createdAt: number; opaqueMessageBase64: string; encrypted?: boolean }[]
> {
	const account = requireActiveAccount('You must be logged in to catch up group messages');
	const sinceEpoch = after === 0 && group.joinEpoch > 0n ? group.joinEpoch.toString() : undefined;
	const result = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
		client.FetchGroupMessages({
			gid,
			after: after > 0 ? after : undefined,
			since_epoch: sinceEpoch
		})
	);
	return result.messages.map((m) => ({
		cursor: m.cursor,
		createdAt: m.at,
		opaqueMessageBase64: m.msg_64,
		encrypted: m.encrypted
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
	seal: Nip44Seal;
	config: MultiDeviceOwnerConfig | undefined;
	ownerPubkey: string;
}): Promise<void> {
	const group = getChatGroup(params.groupId);
	if (!group) return; // vanished (soft-deleted) mid-flight
	const gid = getProtocolGroupId(decodeStoredGroupState(group));

	// 1. Walk this group's `prev` chain from its tip document back to localEpoch (spec §8.5).
	let chain: ChainStep[];
	try {
		chain = await walkGroupChain({
			tipAddress: params.groupAddress,
			groupId: gid,
			localEpoch: params.localEpoch,
			store: makeReadStore(readServers(params.pointer, params.config)),
			addressToUrl: (a) => urlFromTip(a, params.pointer),
			seal: params.seal,
			ownerPubkey: params.ownerPubkey
		});
	} catch (error) {
		dbg('catchUp walk failed; fast-forward preserved liveness', {
			gid: params.groupId,
			error: error instanceof Error ? error.message : String(error)
		});
		return;
	}
	if (chain.length === 0) {
		dbg('catchUp empty chain', { gid: params.groupId });
		return;
	}

	// 2. Fetch the whole gap once (messages after the decrypt frontier).
	let gap: {
		cursor: number;
		createdAt: number;
		opaqueMessageBase64: string;
		encrypted?: boolean;
	}[];
	try {
		gap = await fetchMessageGap(group, gid, params.decryptFrontier);
	} catch (error) {
		dbg('catchUp gap fetch failed; fast-forward preserved liveness', {
			gid: params.groupId,
			error: error instanceof Error ? error.message : String(error)
		});
		return;
	}
	if (gap.length === 0) {
		dbg('catchUp no gap to replay', { gid: params.groupId, steps: chain.length });
		return;
	}

	dbg('catchUp replaying', { gid: params.groupId, steps: chain.length, gap: gap.length });

	// 3. Per-range replay. states[0] = local (s0); states[i>0] = chain[i-1].
	//    Each epoch's messages decrypt with that epoch's gen-0 ClientState;
	//    sibling-Commits skip (shared-leaf guard) and the next step bridges.
	//    mdActive so any partition imperfection skips instead of poisoning. ONE
	//    working session accumulates recovered messages across ranges.
	const account = requireActiveAccount('You must be logged in to catch up group messages');
	const workingGroup = createWorkingChatGroupSession(
		group,
		decodeClientStateBase64(params.localStateBase64)
	);
	workingGroup.fetchCursor = params.decryptFrontier;
	const states = [params.localStateBase64, ...chain.map((s) => s.clientState)];
	const boundaries = [
		params.decryptFrontier,
		...chain.map((s) => s.cursor),
		Number.POSITIVE_INFINITY
	];
	for (let i = 0; i < states.length; i++) {
		const lo = boundaries[i]!;
		const hi = boundaries[i + 1]!;
		const range = gap.filter((m) => m.cursor > lo && m.cursor <= hi);
		if (range.length === 0) continue;
		workingGroup.state = decodeClientStateBase64(states[i]!);
		await ingestChatGroupMessages({
			group: workingGroup,
			messages: range,
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
		if (!cfg?.enabled) return;
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
	const payload = parseConnectionString(connection);
	const decoded = nip19.decode(payload.naddr);
	if (decoded.type !== 'naddr') throw new Error('Invalid connection string');
	const naddr = decoded.data;
	// Persist the inherited config (relays + ephemeral key + d), enabled.
	const config: MultiDeviceOwnerConfig = {
		dTag: naddr.identifier,
		ephemeralPrivateKey: payload.ephemeralPrivateKey,
		ephemeralPubkey: naddr.pubkey,
		relays: naddr.relays?.length ? naddr.relays : DEFAULT_MULTI_DEVICE_RELAYS,
		// ponytail: inherit the default 3-host replication rather than the source's
		// full list — the read path tries them in order and the user can expand.
		blossomServers: DEFAULT_BLOSSOM_SERVERS,
		enabled: true,
		role: 'linked'
	};
	saveConfig(config);

	// Fetch the current tip, then the document, then reconcile.
	const ownerPubkey = normalizePubKey(account.pubkey);
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
}

/** Fetch the latest (greatest created_at) tip event for a config. */
async function fetchLatestTipEvent(config: MultiDeviceOwnerConfig): Promise<NostrEvent | null> {
	let latest: NostrEvent | null = null;
	await new Promise<void>((resolve) => {
		// `request` is the one-off fetch (auto-retry on connection errors, completes
		// on EOSE). Collect the greatest created_at within a 5s cap; the live
		// subscription (startTipSubscription) handles ongoing convergence if this
		// initial fetch is slow or incomplete.
		const sub = relayPool
			.request(
				config.relays,
				{
					kinds: [MULTI_DEVICE_TIP_KIND],
					authors: [config.ephemeralPubkey],
					'#d': [config.dTag]
				},
				{ reconnect: 1, timeout: 5000 }
			)
			.subscribe({
				next: (event) => {
					if (!latest || event.created_at > latest.created_at) latest = event;
				},
				complete: () => resolve(),
				error: () => resolve()
			});
		// ponytail: hard 5s cap in case `request` neither completes nor errors.
		setTimeout(() => {
			try {
				sub.unsubscribe();
			} catch {
				/* best-effort */
			}
			resolve();
		}, 5500);
	});
	return latest;
}

// (ReconcileOutcome is internal to the reconcile target; not re-exported.)
