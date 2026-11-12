import { kinds } from 'nostr-tools';
import { DEFAULT_BOOTSTRAP_RELAY_URLS, type NostrSigner } from '@contextvm/sdk';
import { manager } from '$lib/services/accountManager.svelte';
import {
	getChatCoordinator,
	markCoordinatorRelaysResolved,
	upsertChatCoordinator
} from '$lib/services/chatCoordinators.svelte';
import {
	markCoordinatorDegraded,
	markCoordinatorHealthy,
	resetCoordinatorHealth
} from '$lib/services/coordinatorHealth.svelte';
import {
	resetCoordinatorServerInfo,
	setCoordinatorServerInfo
} from '$lib/services/coordinatorServerInfo.svelte';
import { cordnClient, type coordinatorClient } from '$lib/services/coordinatorClient';
import { createUserRelayListByPubkeyLoader } from '$lib/services/loaders.svelte';
import { eventStore } from '$lib/services/eventStore';
import { defaultRelays, metadataRelays } from '$lib/services/relay-pool';
import { isRelayReachableHere } from '$lib/utils/relayUrl';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { errorMessage, normalizePubKey } from '$lib/utils';
import type { IAccount } from 'applesauce-accounts';

type CoordinatorTarget = {
	serverPubkey: string;
	relays: string[];
};

/**
 * Coordinator connection relays: the coordinator's saved relay configuration,
 * or empty for "unspecified" — the SDK transport then resolves through its own
 * chain (server-identity hints → kind-10002 discovery on its bootstrap relays
 * → fallbackOperationalRelayUrls probe). The blanket client-default fallback
 * this used to apply starved that chain: every relay-less coordinator was
 * hardwired to the contextvm public relays, unreachable for self-hosted
 * servers. Never fall back to the user's globally selected Nostr relays —
 * those are a publish/subscribe concern, not a coordinator-connection
 * concern, and in dev they default to the localhost test relay
 * (ws://localhost:10547), which is not a usable coordinator endpoint.
 */
export function resolveCoordinatorRelays(coordinatorKey: string): string[] {
	return getChatCoordinator(normalizePubKey(coordinatorKey))?.relays ?? [];
}

function resolveCoordinatorTarget(coordinatorKey: string): CoordinatorTarget {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	return {
		serverPubkey: normalizedCoordinatorKey,
		relays: resolveCoordinatorRelays(normalizedCoordinatorKey)
	};
}

class AccountCoordinatorClientRegistry {
	private readonly clients = new Map<string, cordnClient>();

	constructor(private readonly signer: NostrSigner) {}

	private createClient(coordinatorKey: string): cordnClient {
		const target = resolveCoordinatorTarget(coordinatorKey);
		const serverPubkey = target.serverPubkey;
		// Assigned right after construction: the health/server-info callbacks
		// close over it and must ignore signals from a client that has since
		// been swapped out — in-flight calls on a retired client reject with
		// teardown collateral ("Connection closed") during disconnect, which
		// is no evidence about the coordinator.
		// eslint-disable-next-line prefer-const -- closures need the late-bound self reference
		let client: cordnClient | undefined;
		const created = new cordnClient({
			signer: this.signer,
			serverPubkey,
			relays: target.relays,
			// Persist the SDK-resolved relay set for relay-less coordinators
			// (fill-if-empty) so every later client — this session included — takes
			// the configured path instead of re-paying discovery.
			onRelaysResolved: (relayUrls) => markCoordinatorRelaysResolved(serverPubkey, relayUrls),
			onHealth: (signal) => {
				if (client && this.peekClient(serverPubkey) !== client) return;
				if (signal.status === 'healthy') markCoordinatorHealthy(serverPubkey);
				// Only network-class failures are reachability evidence. A signer
				// that cannot sign never reached the coordinator (local identity
				// state), and neither do server application errors or contract
				// parse failures — marking those armed the read breaker and surfaced
				// "Coordinator unreachable" for a healthy coordinator.
				else if (
					!isSignerUnavailableError(signal.error) &&
					isTransientCoordinatorError(signal.error)
				)
					markCoordinatorDegraded(serverPubkey, signal.error);
			},
			onServerInfo: (info) => {
				if (client && this.peekClient(serverPubkey) !== client) return;
				setCoordinatorServerInfo(serverPubkey, info);
			}
		} as ConstructorParameters<typeof cordnClient>[0]);
		client = created;
		return created;
	}

	getClient(coordinatorKey: string): cordnClient {
		const target = resolveCoordinatorTarget(coordinatorKey);
		const existingClient = this.clients.get(target.serverPubkey);

		if (
			existingClient &&
			!existingClient.isClosed &&
			existingClient.relays.length === target.relays.length &&
			existingClient.relays.every((relay, index) => relay === target.relays[index])
		) {
			return existingClient;
		}

		const client = this.createClient(coordinatorKey);
		this.clients.set(target.serverPubkey, client);
		void existingClient?.disconnect().catch(() => undefined);
		return client;
	}

	/** Lookup-only: unlike {@link getClient}, never creates a client. */
	peekClient(coordinatorKey: string): cordnClient | undefined {
		return this.clients.get(resolveCoordinatorTarget(coordinatorKey).serverPubkey);
	}

	/** Snapshot of this registry's coordinator keys (normalized pubkeys). */
	coordinatorKeys(): string[] {
		return [...this.clients.keys()];
	}

	isSigning(): boolean {
		return [...this.clients.values()].some((client) => client.isSigning);
	}

	/**
	 * Swaps in a fresh client for a single coordinator and returns the previous
	 * one for the caller to disconnect. Used by the resume path to bring up a
	 * fresh socket without disrupting healthy coordinators.
	 */
	replaceClient(coordinatorKey: string): cordnClient | undefined {
		const target = resolveCoordinatorTarget(coordinatorKey);
		const oldClient = this.clients.get(target.serverPubkey);
		resetCoordinatorHealth(target.serverPubkey);
		resetCoordinatorServerInfo(target.serverPubkey);
		const client = this.createClient(coordinatorKey);
		this.clients.set(target.serverPubkey, client);
		return oldClient;
	}

	async disconnect(): Promise<void> {
		const entries = [...this.clients.entries()];
		// Drop every client from the map BEFORE awaiting teardown: in-flight
		// calls rejecting during disconnect are collateral, and the guarded
		// onHealth must already see these clients as retired so a torn-down
		// account cannot leave spurious degraded marks behind.
		this.clients.clear();
		for (const [serverPubkey] of entries) {
			resetCoordinatorHealth(serverPubkey);
			resetCoordinatorServerInfo(serverPubkey);
		}
		await Promise.allSettled(entries.map(([, client]) => client.disconnect()));
	}

	async disconnectCoordinator(coordinatorKey: string): Promise<void> {
		const normalized = normalizePubKey(coordinatorKey);
		const client = this.clients.get(normalized);
		if (!client) return;
		this.clients.delete(normalized);
		resetCoordinatorHealth(normalized);
		resetCoordinatorServerInfo(normalized);
		await client.disconnect();
	}
}

const accountClientRegistries = new Map<string, AccountCoordinatorClientRegistry>();

function getAccountRegistryKey(account: IAccount): string {
	return account.id;
}

function getAccountCoordinatorClientRegistry(account: IAccount): AccountCoordinatorClientRegistry {
	const registryKey = getAccountRegistryKey(account);
	let registry = accountClientRegistries.get(registryKey);
	if (!registry) {
		registry = new AccountCoordinatorClientRegistry(account.signer);
		accountClientRegistries.set(registryKey, registry);
	}
	return registry;
}

export function requireActiveAccount(errorMessage: string): IAccount {
	const account = manager.getActive();
	if (!account) {
		throw new Error(errorMessage);
	}
	return account;
}

export function getCoordinatorClient(account: IAccount, coordinatorKey: string) {
	return getAccountCoordinatorClientRegistry(account).getClient(coordinatorKey);
}

export function isCoordinatorSignerActive(): boolean {
	const account = manager.getActive();
	return Boolean(account && accountClientRegistries.get(account.id)?.isSigning());
}

export async function disconnectCoordinatorClients(account?: IAccount): Promise<void> {
	const targetAccount = account ?? manager.getActive();
	if (!targetAccount) {
		return;
	}

	const registryKey = getAccountRegistryKey(targetAccount);
	const registry = accountClientRegistries.get(registryKey);
	if (!registry) {
		return;
	}

	// A rapid switch back must not reuse a registry whose teardown is still running.
	accountClientRegistries.delete(registryKey);
	await registry.disconnect();
}

/** Cheap kind:10002 read deadline over the announcement search set. */
const RELAY_LIST_READ_TIMEOUT_MS = 10_000;

/** Where a coordinator's kind:10002 announcement can live: its own stored
 *  relays (self-hosted announcements), the app defaults, the metadata set,
 *  and the SDK bootstrap relays operators commonly publish to. Stored relays
 *  are filtered to the ones this page can open — an announcement read sent to
 *  a mixed-content ws:// URL can only produce a console error. */
function announcementSearchRelays(stored: string[]): string[] {
	return [
		...new Set([
			...stored.filter(isRelayReachableHere),
			...defaultRelays,
			...metadataRelays,
			...DEFAULT_BOOTSTRAP_RELAY_URLS
		])
	];
}

/** Announced relay URLs from the latest stored kind:10002. Lenient parsing:
 *  raw tags can hold garbage a strict normalize would throw on, and every
 *  marker (read/write/unmarked) is legitimate evidence. */
function announcedRelayUrls(pubkey: string): string[] {
	const event = eventStore.getReplaceable(kinds.RelayList, pubkey);
	if (!event) return [];
	const urls = new Set<string>();
	for (const tag of event.tags) {
		if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue;
		const url = tag[1].trim();
		if (/^wss?:\/\//.test(url)) urls.add(url);
	}
	return [...urls];
}

/** One bounded kind:10002 request; resolves when the loader reports done or
 *  the deadline passes. The raw result is read from the event store after —
 *  newest replaceable event wins, so no first-EOSE relay race. */
function loadRelayListAnnouncement(pubkey: string, relays: string[]): Promise<void> {
	return new Promise((resolve) => {
		const handles: {
			loader?: { unsubscribe: () => void };
			timer?: ReturnType<typeof setTimeout>;
		} = {};
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			if (handles.timer) clearTimeout(handles.timer);
			handles.loader?.unsubscribe();
			resolve();
		};
		handles.loader = createUserRelayListByPubkeyLoader(pubkey, relays).subscribe({
			error: done,
			complete: done
		});
		// Loader may complete synchronously (store already warm); skip the timer.
		if (!settled) handles.timer = setTimeout(done, RELAY_LIST_READ_TIMEOUT_MS);
	});
}

/**
 * A coordinator's currently announced relay set (kind:10002 / CEP-17), read
 * over every relay that could carry the announcement. `[]` = no announcement
 * found anywhere — for such coordinators the stored (or SDK fallback) set is
 * all there is.
 */
export async function fetchAnnouncedCoordinatorRelays(coordinatorKey: string): Promise<string[]> {
	const normalized = normalizePubKey(coordinatorKey);
	const stored = getChatCoordinator(normalized)?.relays ?? [];
	await loadRelayListAnnouncement(normalized, announcementSearchRelays(stored));
	return announcedRelayUrls(normalized);
}

/**
 * Whether the coordinator answers a full MCP connect on exactly these relays
 * (throwaway CONFIGURED client — the SDK's discovery/fallback chain never
 * runs, so the answer is evidence about this coordinator, never about app
 * defaults). This is the only gate between an announcement and an adopted
 * set: callers that persist must verify first.
 */
export async function verifyCoordinatorRelays(
	coordinatorKey: string,
	relayUrls: string[]
): Promise<boolean> {
	const client = new cordnClient({
		serverPubkey: normalizePubKey(coordinatorKey),
		relays: [...relayUrls]
	});
	try {
		return (await client.operationalRelayUrls()).length > 0;
	} catch {
		return false;
	} finally {
		await client.disconnect().catch(() => undefined);
	}
}

/**
 * Re-resolve a coordinator's relays (explicit user action) and OVERWRITE the
 * stored set with the ANNOUNCED relays, verified by a full MCP connect on
 * them — unlike automatic persistence (fill-if-empty), explicit intent
 * replaces, and unlike SDK resolution the answer is the coordinator's own
 * announcement, never a fallback set. The next getClient swaps in a fresh
 * configured client automatically (relays mismatch).
 */
export async function refetchCoordinatorRelays(coordinatorKey: string): Promise<string[]> {
	const normalized = normalizePubKey(coordinatorKey);
	const announced = await fetchAnnouncedCoordinatorRelays(normalized);
	if (!announced.length) return [];
	if (!(await verifyCoordinatorRelays(normalized, announced))) {
		throw new Error('Coordinator did not answer on its announced relays');
	}
	upsertChatCoordinator({ pubkey: normalized, relays: announced });
	return announced;
}

export async function disconnectCoordinatorClient(
	account: IAccount,
	coordinatorKey: string
): Promise<void> {
	const registry = accountClientRegistries.get(getAccountRegistryKey(account));
	if (!registry) return;
	await registry.disconnectCoordinator(coordinatorKey);
}

/**
 * Replace every existing coordinator client for this account with a fresh
 * identity, disconnecting the old sockets in the background. The
 * foreground-rebuild path uses this after a process suspension (phone
 * background / tab freeze / OS sleep): every socket is assumed dead, so
 * reconnects start immediately instead of waiting for in-flight calls to
 * fail. Preserves laziness — coordinators without a client keep having none.
 */
export function rebuildAllCoordinatorClients(
	account: IAccount | undefined = manager.getActive()
): void {
	if (!account) return;
	const queryKey = chatQueryKeys.coordinators(account.pubkey);
	// Cancellation keeps cached data but prevents refresh from joining retired work.
	// Actual network cancellation is owned by client.disconnect(), not Query.
	void queryClient.cancelQueries({ queryKey });
	const registry = accountClientRegistries.get(getAccountRegistryKey(account));
	for (const coordinatorKey of registry?.coordinatorKeys() ?? []) {
		resetCoordinatorHealth(coordinatorKey, { clearBackoff: true });
		replaceCoordinatorClient(coordinatorKey, account);
	}
	void queryClient.invalidateQueries({ queryKey });
}

/** Min spacing between pool probe sweeps — attention events can burst. */
const POOL_PROBE_DEBOUNCE_MS = 15_000;
let lastPoolProbeAt = 0;

/**
 * Probe every live coordinator client's relay pool at an attention event
 * (visible / resume / focus — including signer round-trip returns) and let the
 * pool rebuild itself if any connected relay fails the liveness ping. This
 * closes the post-suspension blind window: sockets that died silently while
 * the process kept running (mobile radio death, one zombie relay) report
 * `connected: true`, so only an explicit probe can catch them — the first RPC
 * through them would otherwise burn its full deadline ("send timed out after
 * 8000ms, retry works"). Cheap, read-only (dummy filter, no signing), and safe
 * alongside in-flight calls: a pool rebuild replays subscriptions and pending
 * responses re-deliver.
 *
 * Resolves only after any failing pool has finished rebuilding (SDK 0.14.0
 * public `probe()`: heal-then-report), so a caller that awaits this and then
 * ticks lands on fresh sockets instead of racing the rebuild.
 */
export async function probeCoordinatorClientPools(reason: string): Promise<void> {
	const account = manager.getActive();
	if (!account) return;
	const registry = accountClientRegistries.get(getAccountRegistryKey(account));
	if (!registry || registry.coordinatorKeys().length === 0) return;
	const now = Date.now();
	if (now - lastPoolProbeAt < POOL_PROBE_DEBOUNCE_MS) return;
	lastPoolProbeAt = now;
	console.debug('[coordinator] pool liveness probe', {
		reason,
		coordinators: registry.coordinatorKeys().length
	});
	await Promise.allSettled(
		registry.coordinatorKeys().map(async (coordinatorKey) => {
			const client = registry.peekClient(coordinatorKey);
			if (!client || client.isClosed || !client.pool) return;
			await client.pool.probe();
		})
	);
}

export function isTransientCoordinatorError(error: unknown): boolean {
	const detail = errorMessage(error);
	// `open stream aborted` / `keepalive` covers the CEP-41 probe failures
	// ("Open stream aborted: Probe timeout" already matches via `timeout`, but
	// "...Failed to send keepalive ping" only matches via `keepalive`). Without
	// these, a dead keepalive aborts the subscription without scheduling a
	// resume, leaving the group unwatched until the next foreground event.
	// `publish aborted` is the lifecycle pool cancelling in-flight publishes on
	// client teardown; `not connected` is the MCP client rejecting a request
	// whose transport closed mid-flight — both are client-lifecycle artifacts,
	// never permanent coordinator state.
	return /timeout|timed out|connection closed|failed to publish event|relay rejected publish|network|disconnected|not connected|publish aborted|open stream aborted|keepalive/i.test(
		detail
	);
}

/**
 * Backoff schedule (ms) between signer-not-ready retries. Mobile NIP-46 /
 * extension signers can take several seconds to wake from suspension; a tight
 * fixed-delay window surfaces recoverable cold-start failures as flaky errors.
 * One attempt per entry plus the initial call widens the window to ~4.5s.
 */
const SIGNER_READY_RETRY_DELAYS_MS = [500, 1000, 1000, 2000];

export function isSignerUnavailableError(error: unknown): boolean {
	const message = errorMessage(error);
	return /signer extension missing/i.test(message);
}

/**
 * Run a coordinator call, retrying on signer-not-ready errors. The NIP-46 /
 * extension signer can take a moment to become ready after account activation
 * or to wake from suspension on mobile, so bounded backoff retries cover the
 * cold-start window without surfacing a spurious failure to the user.
 */
export async function withCoordinatorClientRetry<T>(
	account: IAccount,
	coordinatorKey: string,
	operation: (client: coordinatorClient) => Promise<T>,
	options: { signal?: AbortSignal } = {}
): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await withCoordinatorClient(account, coordinatorKey, operation, options);
		} catch (error) {
			const delay = SIGNER_READY_RETRY_DELAYS_MS[attempt];
			if (!isSignerUnavailableError(error) || delay === undefined) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

/** Reject old account/query results before callers can commit them to local stores. */
export function assertCoordinatorOperationActive(account: IAccount, signal?: AbortSignal): void {
	signal?.throwIfAborted();
	if (manager.getActive()?.id !== account.id) {
		throw new DOMException('Account changed', 'AbortError');
	}
}

/**
 * Independent RPCs need no transport lock; MLS writes retain their per-group lock.
 * Never replay an arbitrary callback: a timed-out msg_post/kp_take may have succeeded.
 * Query owns read retries; the signer wrapper retries only known not-signed failures.
 */
export async function withCoordinatorClient<T>(
	account: IAccount,
	coordinatorKey: string,
	operation: (client: coordinatorClient) => Promise<T>,
	options: { signal?: AbortSignal } = {}
): Promise<T> {
	assertCoordinatorOperationActive(account, options.signal);
	const client = getCoordinatorClient(account, coordinatorKey);
	try {
		const result = await operation(client);
		// Keep the account guard (never hand a switched account another account's
		// result), but do NOT discard a COMPLETED call's result because its client
		// was since swapped/disconnected: a finished msg_post has landed, and
		// reporting it as a failure breeds duplicate re-posts and stuck "queued"
		// bubbles on every foreground client rebuild. Read consumers that care
		// about staleness already gate on isCurrentCoordinatorClient after fetch.
		assertCoordinatorOperationActive(account, options.signal);
		return result;
	} catch (error) {
		assertCoordinatorOperationActive(account, options.signal);
		if (isTransientCoordinatorError(error) || isSignerUnavailableError(error)) {
			replaceCoordinatorClient(coordinatorKey, account, client);
		}
		throw error;
	}
}

/**
 * Whether `client` is still the registry's current client for this
 * coordinator. Failures observed on a retired client are teardown collateral
 * from an earlier swap — not new evidence about the coordinator.
 */
export function isCurrentCoordinatorClient(
	coordinatorKey: string,
	client: coordinatorClient,
	account: IAccount | undefined = manager.getActive()
): boolean {
	if (!account) return false;
	const registry = accountClientRegistries.get(getAccountRegistryKey(account));
	return registry !== undefined && registry.peekClient(coordinatorKey) === client;
}

/**
 * Rebuild a single coordinator's client so subsequent calls use a fresh
 * socket. Synchronous swap, fire-and-forget teardown: a hung connect or
 * wedged publish on the old socket must never block the rebuild. The fresh
 * client is independent; the old one dies in the background.
 *
 * When `expectedClient` is provided and no longer current, the swap is
 * skipped: the failure that prompted it came from an already-retired client,
 * and tearing down the replacement mid-handshake would only breed another
 * round of collateral failures.
 */
export function replaceCoordinatorClient(
	coordinatorKey: string,
	account: IAccount | undefined = manager.getActive(),
	expectedClient?: coordinatorClient
): void {
	if (!account) {
		return;
	}

	const registry = accountClientRegistries.get(getAccountRegistryKey(account));
	if (!registry) {
		return;
	}

	if (expectedClient && registry.peekClient(coordinatorKey) !== expectedClient) {
		console.debug('[coordinator] failure observed on retired client — swap skipped', {
			coordinatorKey
		});
		return;
	}

	const oldClient = registry.replaceClient(coordinatorKey);
	if (!oldClient) {
		return;
	}

	void oldClient.disconnect().catch(() => undefined);
}
