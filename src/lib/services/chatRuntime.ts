import { manager } from '$lib/services/accountManager.svelte';
import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
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
import { defaultRelays } from '$lib/services/relay-pool';
import { errorMessage, normalizePubKey } from '$lib/utils';
import type { NostrSigner } from '@contextvm/sdk';
import type { IAccount } from 'applesauce-accounts';

type CoordinatorTarget = {
	serverPubkey: string;
	relays: string[];
};

function resolveCoordinatorRelays(coordinator: ReturnType<typeof getChatCoordinator>): string[] {
	// Explicit saved relays win; otherwise defaultRelays. Same rule as the
	// guest path (resolveGuestCoordinatorRelays). Never fall back to the user's
	// globally selected Nostr relays — those are a publish/subscribe concern,
	// not a coordinator-connection concern, and in dev they default to the
	// localhost test relay (ws://localhost:10547), which is not a usable
	// coordinator endpoint for a freshly stored coordinator.
	if (coordinator?.relays.length) {
		return coordinator.relays;
	}
	return defaultRelays;
}

function resolveCoordinatorTarget(coordinatorKey: string): CoordinatorTarget {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	const coordinator = getChatCoordinator(normalizedCoordinatorKey);
	return {
		serverPubkey: normalizedCoordinatorKey,
		relays: resolveCoordinatorRelays(coordinator)
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
			onHealth: (signal) => {
				if (client && this.peekClient(serverPubkey) !== client) return;
				if (signal.status === 'healthy') markCoordinatorHealthy(serverPubkey);
				// A signer that cannot sign means no request ever reached the
				// coordinator — that is local identity state, not reachability, so it
				// must not mark the coordinator degraded.
				else if (!isSignerUnavailableError(signal.error))
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

		if (existingClient) {
			return existingClient;
		}

		const client = this.createClient(coordinatorKey);
		this.clients.set(target.serverPubkey, client);
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

/** Coordinators with an old client disconnecting in the background. */
const rebuildingClients = new Set<string>();

/** Upper bound on how long a background old-client teardown may pin the
 * rebuild gate — the swap itself is synchronous, this only covers a hung
 * transport close on the retired client. */
const REBUILD_PIN_MAX_MS = 30_000;

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

export function isCoordinatorClientRefreshInProgress(coordinatorKey?: string): boolean {
	// Scoped when a coordinator key is given: only THAT coordinator's rebuild
	// pauses its queries — a hard-down coordinator's constant client swaps
	// must not flap `enabled` (and polling) for healthy coordinators app-wide.
	if (!coordinatorKey?.trim()) return rebuildingClients.size > 0;
	const account = manager.getActive();
	if (!account) return false;
	return rebuildingClients.has(
		`${getAccountRegistryKey(account)}::${normalizePubKey(coordinatorKey)}`
	);
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

	await registry.disconnect();
	accountClientRegistries.delete(registryKey);
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
	const registry = accountClientRegistries.get(getAccountRegistryKey(account));
	if (!registry) return;
	for (const coordinatorKey of registry.coordinatorKeys()) {
		replaceCoordinatorClient(coordinatorKey, account);
	}
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
	options: { transientRetries?: boolean } = {}
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

/**
 * In-memory per-coordinator operation queue used to flush operations that
 * were requested while `replaceCoordinatorClient()` is rebuilding the
 * coordinator client.
 */
function getCoordinatorOperationKey(account: IAccount, coordinatorKey: string): string {
	return `${getAccountRegistryKey(account)}::${normalizePubKey(coordinatorKey)}`;
}

const coordinatorOperationChains = new Map<string, Promise<void>>();

async function runCoordinatorOperation<T>(
	account: IAccount,
	coordinatorKey: string,
	operation: () => Promise<T>
): Promise<T> {
	const chainKey = getCoordinatorOperationKey(account, coordinatorKey);
	const previous = coordinatorOperationChains.get(chainKey) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.catch(() => undefined).then(() => current);
	coordinatorOperationChains.set(chainKey, tail);
	const queued = previous.catch(() => undefined).then(() => operation());
	try {
		return await queued;
	} finally {
		release();
		if (coordinatorOperationChains.get(chainKey) === tail) {
			coordinatorOperationChains.delete(chainKey);
		}
	}
}

/**
 * Backoff (ms) between retries after the initial transient failure. The first
 * failure rebuilds the client (the socket may be stale); these sleeps space
 * out further retries on the rebuilt client. One reconnect per call instead
 * of churning on a coordinator that may be genuinely down.
 */
const TRANSIENT_RETRY_BACKOFF_MS = [500, 1000, 2000];

export async function withCoordinatorClient<T>(
	account: IAccount,
	coordinatorKey: string,
	operation: (client: coordinatorClient) => Promise<T>,
	options: { transientRetries?: boolean } = {}
): Promise<T> {
	// Polling reads opt out of the transient-retry ladder: the next poll is the
	// retry, so a dead coordinator costs one attempt instead of four. Still swap
	// a fresh client on a transient failure so a wedged socket doesn't survive
	// the read-backoff window (coordinatorHealth).
	if (options.transientRetries === false) {
		return runCoordinatorOperation(account, coordinatorKey, async () => {
			const client = getCoordinatorClient(account, coordinatorKey);
			try {
				return await operation(client);
			} catch (error) {
				if (isTransientCoordinatorError(error)) {
					replaceCoordinatorClient(coordinatorKey, account, client);
				}
				throw error;
			}
		});
	}
	return runCoordinatorOperation(account, coordinatorKey, async () => {
		let rebuilt = false;
		let client: coordinatorClient | undefined;
		for (let attempt = 0; attempt <= TRANSIENT_RETRY_BACKOFF_MS.length; attempt += 1) {
			try {
				client = getCoordinatorClient(account, coordinatorKey);
				return await operation(client);
			} catch (error) {
				if (!isTransientCoordinatorError(error)) {
					throw error;
				}
				if (attempt === TRANSIENT_RETRY_BACKOFF_MS.length) {
					throw error;
				}
				if (!rebuilt) {
					// First transient failure: the socket may be stale, so rebuild once.
					// Later retries reuse the fresh client rather than paying more
					// reconnect cycles on a coordinator that may be genuinely down.
					// The observed client rides along: if it was already retired by a
					// concurrent swap, this failure is teardown collateral, not evidence.
					rebuilt = true;
					await replaceCoordinatorClient(coordinatorKey, account, client);
				}
				await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_BACKOFF_MS[attempt]));
			}
		}
		throw new Error('Unreachable: transient retry loop exhausted');
	});
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

	const chainKey = getCoordinatorOperationKey(account, coordinatorKey);
	rebuildingClients.add(chainKey);
	// Safety net: a transport close that never settles must not pin the
	// rebuild gate (and its query pause) on this coordinator forever.
	const unpin = () => rebuildingClients.delete(chainKey);
	setTimeout(unpin, REBUILD_PIN_MAX_MS);
	void oldClient
		.disconnect()
		.catch(() => undefined)
		.finally(unpin);
}
