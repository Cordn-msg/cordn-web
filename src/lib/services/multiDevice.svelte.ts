/**
 * Multi-device session sync service layer (see `multiDevice.ts` for the pure
 * protocol core and `cordn/spec/applications/multi-device.md` for the spec).
 *
 * Owns the per-owner multi-device config (enable flag, the once-generated
 * ephemeral signing keypair + stable `d`, the editable relay set, and the last
 * published document address) in localStorage keyed by owner pubkey. Wires
 * the pure core to the real account signer, Blossom, the chat group store,
 * and the applesauce relay pool.
 *
 * Tip transport (spec §6): an opaque replaceable `kind:30078` event signed by
 * the persisted ephemeral key, whose `content` is a NIP-44 seal (to the owner
 * npub) of an owner-signed inner `kind:178` event carrying `x` (document
 * sha256) + ordered `server` tags. The owner npub never appears on the wire.
 *
 * Connection string (spec §11): a payload carrying the outer-event locator
 * (naddr: kind + ephemeral pubkey + `d` + relay hints) and the ephemeral write
 * key, encoded for QR/paste. Carries NO owner key material.
 *
 * Re-publish hook (spec §10): `onLocalStateAdvance()` is fire-and-forget and a
 * no-op when multi-device is disabled or no signer/seal is available. Wired at
 * group creation and on locally-authored Commit confirmation elsewhere.
 */
import { browser } from '$app/environment';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';

import { manager } from '$lib/services/accountManager.svelte';
import { relayPool, defaultRelays } from '$lib/services/relay-pool';
import { uploadBlob, fetchBlob, type BlossomSigner } from '$lib/services/chatBlossomClient';
import { BLOSSOM_SERVERS, DEFAULT_BLOSSOM_SERVER } from '$lib/constants/chat';
import {
	listChatGroups,
	getChatGroup,
	importChatGroups,
	replaceGroup,
	decodeStoredGroupState,
	reloadChatGroupsForOwner,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import { getProtocolGroupId } from '$lib/services/chatGroupLifecycle.svelte';
import { normalizePubKey } from '$lib/utils';
import {
	publishCurrentSession,
	pullSessionDocument,
	reconcileFromDocument,
	entryEpoch,
	type Nip44Seal,
	type SessionBlobStore,
	type SessionGroupSnapshot,
	type SessionGroupEntry,
	type ReconcileTarget
} from '$lib/services/multiDevice';

/**
 * Outer replaceable event kind (spec §14 — a coordination detail all clients
 * must agree on). The exact value is a coordination detail; this is cordn-web's
 * choice for the opaque tip transport.
 */
export const MULTI_DEVICE_TIP_KIND = 30078;
/** Inner, sealed, owner-signed event kind (self-labeling; never relayed). */
export const MULTI_DEVICE_INNER_KIND = 178;

const CONFIG_STORAGE_KEY = 'cordn.multiDevice';

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
	/** Blossom server URLs that host the sealed document (ordered, most-reliable first). */
	blossomServers: string[];
	/** Last published document address (sha256 of the sealed doc). Forms the `prev` chain. */
	lastPublishedAddress?: string;
	/** Whether sync is active. When false, no publishing, no subscription. */
	enabled: boolean;
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
	return readAllConfigs()[normalizePubKey(owner)];
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
function createFreshConfig(relays: string[] = defaultRelays): MultiDeviceOwnerConfig {
	const sk = generateSecretKey();
	const ephemeralPrivateKey = bytesToHex(sk);
	const ephemeralPubkey = getPublicKey(sk);
	return {
		dTag: generateDTag(),
		ephemeralPrivateKey,
		ephemeralPubkey,
		relays,
		// ponytail: reuse the media server list as the document hosts. The first
		// entry is the configured default; the read path tries them in order.
		blossomServers: [
			DEFAULT_BLOSSOM_SERVER,
			...BLOSSOM_SERVERS.filter((s) => s !== DEFAULT_BLOSSOM_SERVER)
		],
		enabled: true
	};
}

/**
 * Enable multi-device for the active owner, generating a fresh config if none
 * exists. Returns the (now-active) config so the UI can render the connection
 * string. Throws if no active account or the signer can't NIP-44 seal.
 */
export function enableMultiDevice(relays?: string[]): MultiDeviceOwnerConfig {
	if (!browser) throw new Error('Multi-device can only run in the browser');
	const account = manager.getActive();
	if (!account) throw new Error('Log in to enable multi-device sync');
	dbg('enableMultiDevice enter', { hadAccount: !!account, relayCount: relays?.length ?? 0 });
	const existing = getMultiDeviceConfig(account.pubkey);
	const config = existing ?? createFreshConfig(relays);
	if (relays && relays.length) config.relays = relays;
	config.enabled = true;
	saveConfig(config);
	dbg('enableMultiDevice done', { dTag: config.dTag.slice(0, 8), enabled: config.enabled });
	// Spec §11: the connection string is only usable once a document + tip exist.
	// A user enabling with existing groups would otherwise see "last published:
	// never" forever (the re-publish hook only fires on new-group/own-commit).
	// Publish the current snapshot immediately so the string is live.
	onLocalStateAdvance();
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
	stopTipSubscription();
}

/** Rotate the ephemeral keypair + `d` together (spec §11). All devices must re-link. */
export function rotateMultiDeviceKey(relays?: string[]): MultiDeviceOwnerConfig {
	if (!browser) throw new Error('Multi-device can only run in the browser');
	const account = manager.getActive();
	if (!account) throw new Error('Log in to rotate the multi-device key');
	const existing = getMultiDeviceConfig(account.pubkey);
	const fresh = createFreshConfig(relays ?? existing?.relays);
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

/** Normalize a Blossom URL to trailing-slash form (matches BLOSSOM_SERVERS). */
function normalizeServerUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) return DEFAULT_BLOSSOM_SERVER;
	return trimmed.replace(/\/+$/, '') + '/';
}

/** The user-selected primary Blossom server (the rest are preset fallbacks). */
export function getMultiDeviceBlossomServer(): string {
	return getMultiDeviceConfig()?.blossomServers[0] ?? DEFAULT_BLOSSOM_SERVER;
}

export function isCustomMultiDeviceBlossomServer(): boolean {
	return !BLOSSOM_SERVERS.includes(
		getMultiDeviceBlossomServer() as (typeof BLOSSOM_SERVERS)[number]
	);
}

/** Set the primary Blossom server; presets fill the remaining fallback slots. */
export function setMultiDeviceBlossomServer(url: string): void {
	const config = getMultiDeviceConfig();
	if (!config) throw new Error('Enable multi-device before setting the Blossom server');
	const primary = normalizeServerUrl(url);
	config.blossomServers = [primary, ...BLOSSOM_SERVERS.filter((s) => s !== primary)];
	saveConfig(config);
	// The document address is stable (content-addressed), so a server change only
	// needs the tip re-published with the new server list — but republishing also
	// re-uploads to the new primary, guaranteeing it's reachable. Cheap; just do it.
	onLocalStateAdvance();
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

/** Blossom store for the sealed session document (spec §12), ephemeral-signed. */
function makeBlossomStore(signer: BlossomSigner): SessionBlobStore {
	return {
		async publish(blob) {
			// Try each configured server; first success wins (ordered, most-reliable first).
			const config = getMultiDeviceConfig();
			const servers = config?.blossomServers ?? BLOSSOM_SERVERS;
			let lastError: unknown;
			for (const server of servers) {
				try {
					const uploaded = await uploadBlob({ serverUrl: server, blob, signer });
					dbg('blossom upload ok', {
						server,
						sha256: uploaded.sha256.slice(0, 12),
						bytes: blob.byteLength
					});
					return { address: uploaded.sha256, url: uploaded.url };
				} catch (error) {
					dbg('blossom upload failed', { server, error: (error as Error)?.message });
					lastError = error;
				}
			}
			throw lastError instanceof Error
				? new Error(`All Blossom servers failed: ${lastError.message}`)
				: new Error('All Blossom servers failed');
		},
		async fetch(url) {
			return fetchBlob(url);
		}
	};
}

/** Map a content address to the Blossom GET URL (BUD-01). */
function addressToBlossomUrl(address: string): string {
	const config = getMultiDeviceConfig();
	const server = (config?.blossomServers[0] ?? DEFAULT_BLOSSOM_SERVER).replace(/\/+$/, '');
	return `${server}/${address}`;
}

// ---------------------------------------------------------------------------
// Tip transport (spec §6)
// ---------------------------------------------------------------------------

/** Build the owner-signed inner event pointing at the document address. */
async function buildInnerTipEvent(params: {
	address: string;
	blossomServers: string[];
	ownerPubkey: string;
}): Promise<NostrEvent> {
	const template = {
		kind: MULTI_DEVICE_INNER_KIND,
		pubkey: params.ownerPubkey,
		content: '',
		created_at: Math.floor(Date.now() / 1000),
		tags: [['x', params.address], ...params.blossomServers.map((s) => ['server', s])]
	};
	const account = manager.getActive();
	if (!account) throw new Error('No active account to sign the tip');
	// Inner event MUST be owner-signed (spec §6) — that is the authenticity
	// guarantee for the document, since the seal is confidentiality-only.
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

export interface TipPointer {
	address: string;
	blossomServers: string[];
}

/** Parse + verify an outer tip event into the document pointer it carries. */
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
	const xTag = inner.tags.find((t) => t[0] === 'x');
	const serverTags = inner.tags.filter((t) => t[0] === 'server').map((t) => t[1]);
	if (!xTag) return null;
	return { address: xTag[1], blossomServers: serverTags };
}

/** Publish a tip for the current document address. */
async function publishTip(address: string, config: MultiDeviceOwnerConfig): Promise<void> {
	const account = manager.getActive();
	if (!account) return;
	const ownerPubkey = normalizePubKey(account.pubkey);
	const inner = await buildInnerTipEvent({
		address,
		blossomServers: config.blossomServers,
		ownerPubkey
	});
	dbg('tip inner owner-signed', { address: address.slice(0, 12) });
	const { seal } = getActiveNip44Seal() ?? {};
	if (!seal) throw new Error('Active account cannot NIP-44 seal (signer lacks nip44)');
	const sealedContent = await seal.encrypt(ownerPubkey, JSON.stringify(inner));
	const outer = buildOuterTipEvent({
		innerEvent: inner,
		sealedContent,
		ephemeralPrivateKey: config.ephemeralPrivateKey,
		ephemeralPubkey: config.ephemeralPubkey,
		dTag: config.dTag
	});
	const responses = await relayPool.publish(config.relays, outer);
	dbg('tip outer published', { relays: config.relays, accepted: responses.length });
}

// ---------------------------------------------------------------------------
// Connection string (spec §11)
// ---------------------------------------------------------------------------

export interface ConnectionPayload {
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
 * The fire-and-forget re-publish hook (spec §10). Snapshots the active
 * session, seals + publishes the document, and moves the tip. No-op when
 * multi-device is disabled, no account, or the signer can't NIP-44 seal.
 * Publishing latency never blocks the caller; errors are logged, not thrown.
 *
 * Wired at group creation and on locally-authored Commit confirmation; the
 * common case (application traffic) needs no re-publish.
 */
export function onLocalStateAdvance(): void {
	if (!browser) return;
	const config = getMultiDeviceConfig();
	if (!config?.enabled) {
		// ponytail: noisy if left on; uncomment to trace why a publish didn't fire.
		// dbg('onLocalStateAdvance skip', { enabled: config?.enabled });
		return;
	}
	dbg('onLocalStateAdvance fired', { dTag: config.dTag.slice(0, 8) });
	// Chain off the previous publish so concurrent advances coalesce (last wins,
	// per-group epoch comparison converges — spec §8).
	publishInFlight = publishInFlight
		.catch(() => {})
		.then(() => republishSessionDocument())
		.catch((error) => {
			console.warn('[multi-device] re-publish failed', error);
		});
}

async function republishSessionDocument(): Promise<void> {
	const config = getMultiDeviceConfig();
	if (!config?.enabled) {
		dbg('republish skip', { reason: 'disabled' });
		return;
	}
	const active = getActiveNip44Seal();
	if (!active) {
		dbg('republish skip', { reason: 'no nip44 seal' });
		return;
	}
	const { seal, ownerPubkey } = active;
	const groups = collectSessionSnapshots();
	dbg('republish snapshot', { groupCount: groups.length });
	if (groups.length === 0) {
		dbg('republish skip', { reason: 'no active groups to publish' });
		return;
	}
	// Ephemeral Blossom signer (spec §12 — never the owner npub). Reuse the
	// persisted ephemeral key so the same identity authorizes uploads across
	// devices; its leak is denial-of-service only.
	const signer: BlossomSigner = {
		async signEvent(template) {
			return finalizeEvent(template, hexToBytes(config.ephemeralPrivateKey));
		}
	};
	const store = makeBlossomStore(signer);
	const result = await publishCurrentSession({
		groups,
		seal,
		ownerPubkey,
		store,
		prev: config.lastPublishedAddress
	});
	dbg('republish document uploaded', {
		address: result.address.slice(0, 12),
		storeUrl: result.url
	});
	await publishTip(result.address, config);
	dbg('republish tip published', { relays: config.relays });
	config.lastPublishedAddress = result.address;
	saveConfig(config);
}

/** Snapshot every active local group for the session document (spec §4). */
function collectSessionSnapshots(): SessionGroupSnapshot[] {
	const groups: SessionGroupSnapshot[] = [];
	for (const group of listChatGroups()) {
		if (group.status && group.status !== 'active') continue;
		const state = decodeStoredGroupState(group);
		groups.push({
			gid: getProtocolGroupId(state),
			state,
			coordinatorKey: group.coordinatorKey,
			metadata: group.metadata,
			encrypted: true, // outbound sealing is always on (see sealForPosting)
			fetchCursor: group.fetchCursor
		});
	}
	return groups;
}

// ---------------------------------------------------------------------------
// Tip subscription + reconciliation (the linked-device read path)
// ---------------------------------------------------------------------------

let tipSubscription: { unsubscribe: () => void } | null = null;

/**
 * Subscribe to the tip replaceable event for the active owner's config and
 * reconcile on every change. Idempotent: re-subscribing tears down the prior
 * subscription first. No-op when disabled.
 */
export function startTipSubscription(): void {
	if (!browser) return;
	const config = getMultiDeviceConfig();
	if (!config?.enabled) return;
	stopTipSubscription();
	const filter = {
		kinds: [MULTI_DEVICE_TIP_KIND],
		authors: [config.ephemeralPubkey],
		'#d': [config.dTag]
	};
	const ownerPubkey = normalizePubKey(manager.getActive()!.pubkey);
	tipSubscription = relayPool
		.subscription(config.relays, filter, { reconnect: Infinity, resubscribe: true })
		.subscribe({
			next: (event) => {
				void handleTipEvent(event, ownerPubkey).catch((error) => {
					console.warn('[multi-device] tip reconcile failed', error);
				});
			}
		});
}

export function stopTipSubscription(): void {
	if (tipSubscription) {
		try {
			tipSubscription.unsubscribe();
		} catch {
			/* best-effort */
		}
		tipSubscription = null;
	}
}

let lastReconciledAddress: string | undefined;

async function handleTipEvent(
	outer: NostrEvent,
	ownerPubkey: string
): Promise<{ seeded: number; fastForwarded: number; skipped: number } | null> {
	const pointer = await parseTipEvent(outer, ownerPubkey);
	if (!pointer) return null;
	// Replaceable events can replay; skip if we already reconciled this address.
	if (pointer.address === lastReconciledAddress) return null;
	const { seal } = getActiveNip44Seal() ?? {};
	if (!seal) return null;
	const config = getMultiDeviceConfig();
	// Fetch the document from the tip's advertised servers (ordered), falling
	// back to the locally-configured server list.
	const primaryUrl = pointer.blossomServers[0]
		? `${pointer.blossomServers[0].replace(/\/+$/, '')}/${pointer.address}`
		: addressToBlossomUrl(pointer.address);
	const store: SessionBlobStore = {
		async publish() {
			throw new Error('read-only store');
		},
		async fetch() {
			const urls = [
				primaryUrl,
				...pointer.blossomServers.slice(1).map((s) => `${s.replace(/\/+$/, '')}/${pointer.address}`)
			];
			let lastError: unknown;
			for (const url of urls) {
				try {
					return await fetchBlob(url);
				} catch (error) {
					lastError = error;
				}
			}
			// Fall back to the locally-configured server list.
			for (const server of config?.blossomServers ?? BLOSSOM_SERVERS) {
				try {
					return await fetchBlob(`${server.replace(/\/+$/, '')}/${pointer.address}`);
				} catch (error) {
					lastError = error;
				}
			}
			throw lastError instanceof Error
				? new Error(`Could not fetch session document: ${lastError.message}`)
				: new Error('Could not fetch session document');
		}
	};
	const doc = await pullSessionDocument({
		address: pointer.address,
		store,
		addressToUrl: (a) => `${pointer.blossomServers[0]?.replace(/\/+$/, '') ?? ''}/${a}`,
		seal,
		ownerPubkey
	});
	const target = makeReconcileTarget(ownerPubkey);
	const result = await reconcileFromDocument(target, doc);
	lastReconciledAddress = pointer.address;
	if (result.seeded.length > 0) {
		// Seeding changes the group set; refresh the in-memory store.
		await reloadChatGroupsForOwner(ownerPubkey);
	}
	// ponytail: do not auto-republish on read (spec §8 SHOULD). The next local
	// advance republishes; republishing here risks a publish loop across devices.
	return {
		seeded: result.seeded.length,
		fastForwarded: result.fastForwarded.length,
		skipped: result.skipped.length
	};
}

/**
 * Build a `ReconcileTarget` over the live chat group store. Seeding installs a
 * new `StoredChatGroup` (via importChatGroups + store refresh); fast-forward
 * replaces an existing group's state+cursor only at a strictly newer epoch.
 */
function makeReconcileTarget(ownerPubkey: string): ReconcileTarget {
	return {
		localEpoch(gid) {
			const group = getChatGroup(gid);
			if (!group) return undefined;
			return decodeStoredGroupState(group).groupContext.epoch;
		},
		async applyEntry(entry) {
			const existing = getChatGroup(entry.gid);
			if (!existing) {
				await seedGroup(entry, ownerPubkey);
				return 'seeded';
			}
			const incomingEpoch = entryEpoch(entry);
			const localEpoch = decodeStoredGroupState(existing).groupContext.epoch;
			// Forward-only epoch check (spec §8) — the rollback defense.
			if (incomingEpoch === undefined || incomingEpoch <= localEpoch) {
				return 'skipped';
			}
			fastForwardGroup(existing, entry);
			return 'fast-forwarded';
		}
	};
}

/** Seed a missing group from a document entry (spec §9). */
async function seedGroup(entry: SessionGroupEntry, ownerPubkey: string): Promise<void> {
	// ponytail: joinEpoch 0 — seeded groups adopt the writer's current state via
	// clientState, so there's no pre-membership boundary to filter (spec §9).
	const seeded: StoredChatGroup = {
		id: entry.gid,
		ownerPubkey,
		coordinatorKey: entry.coordinator,
		createdAt: Date.now(),
		stateBase64: entry.clientState,
		lastCursor: entry.cursor,
		fetchCursor: entry.cursor,
		messages: [],
		syncIssues: [],
		snapshots: [],
		metadata: entry.metadata,
		joinEpoch: 0n,
		status: 'active'
	};
	await importChatGroups([seeded]);
}

/** Fast-forward an existing group to a strictly newer epoch (spec §8). */
function fastForwardGroup(existing: StoredChatGroup, entry: SessionGroupEntry): void {
	const next: StoredChatGroup = {
		...existing,
		stateBase64: entry.clientState,
		metadata: entry.metadata ?? existing.metadata,
		coordinatorKey: entry.coordinator,
		// Cursor advances to the entry's (the adopted state processed through it).
		fetchCursor: Math.max(existing.fetchCursor, entry.cursor),
		lastCursor: Math.max(existing.lastCursor, entry.cursor)
	};
	replaceGroup(existing.id, next);
}

// ---------------------------------------------------------------------------
// Device-link bootstrap (spec §11)
// ---------------------------------------------------------------------------

export interface LinkResult {
	seeded: number;
	fastForwarded: number;
	skipped: number;
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
		relays: naddr.relays?.length ? naddr.relays : defaultRelays,
		blossomServers: [
			DEFAULT_BLOSSOM_SERVER,
			...BLOSSOM_SERVERS.filter((s) => s !== DEFAULT_BLOSSOM_SERVER)
		],
		enabled: true
	};
	saveConfig(config);

	// Fetch the current tip, then the document, then reconcile.
	const ownerPubkey = normalizePubKey(account.pubkey);
	const tipEvent = await fetchLatestTipEvent(config);
	let result: LinkResult = { seeded: 0, fastForwarded: 0, skipped: 0 };
	if (tipEvent) {
		const reconciled = await handleTipEvent(tipEvent, ownerPubkey);
		if (reconciled) result = reconciled;
	}
	// Live subscription reconciles on every subsequent tip move (spec §6).
	startTipSubscription();
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
