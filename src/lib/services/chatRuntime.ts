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
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
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
		// Query unmounts discard read results, but must not close concurrent writes
		// or streams. The RPC remains bounded; lifecycle resets disconnect its owner.
		assertCoordinatorOperationActive(account, options.signal);
		client.signal.throwIfAborted();
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
