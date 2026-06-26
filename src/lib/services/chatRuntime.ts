import { manager } from '$lib/services/accountManager.svelte';
import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
import {
	markCoordinatorDegraded,
	markCoordinatorHealthy,
	resetCoordinatorHealth
} from '$lib/services/coordinatorHealth.svelte';
import { cordnClient, type coordinatorClient } from '$lib/services/coordinatorClient';
import { defaultRelays } from '$lib/services/relay-pool';
import { normalizePubKey } from '$lib/utils';
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
		return new cordnClient({
			signer: this.signer,
			serverPubkey,
			relays: target.relays,
			onHealth: (signal) => {
				if (signal.status === 'healthy') markCoordinatorHealthy(serverPubkey);
				else markCoordinatorDegraded(serverPubkey, signal.error);
			}
		} as ConstructorParameters<typeof cordnClient>[0]);
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

	/**
	 * Swaps in a fresh client for a single coordinator and returns the previous
	 * one for the caller to disconnect. Used by the resume path to bring up a
	 * fresh socket without disrupting healthy coordinators.
	 */
	replaceClient(coordinatorKey: string): cordnClient | undefined {
		const target = resolveCoordinatorTarget(coordinatorKey);
		const oldClient = this.clients.get(target.serverPubkey);
		resetCoordinatorHealth(target.serverPubkey);
		const client = this.createClient(coordinatorKey);
		this.clients.set(target.serverPubkey, client);
		return oldClient;
	}

	async disconnect(): Promise<void> {
		for (const serverPubkey of this.clients.keys()) {
			resetCoordinatorHealth(serverPubkey);
		}
		await Promise.allSettled([...this.clients.values()].map((client) => client.disconnect()));
		this.clients.clear();
	}

	async disconnectCoordinator(coordinatorKey: string): Promise<void> {
		const normalized = normalizePubKey(coordinatorKey);
		const client = this.clients.get(normalized);
		if (!client) return;
		this.clients.delete(normalized);
		resetCoordinatorHealth(normalized);
		await client.disconnect();
	}
}

const accountClientRegistries = new Map<string, AccountCoordinatorClientRegistry>();

/**
 * Per-(account, coordinator) in-flight client rebuild promises. Keyed by the
 * same chain key as `coordinatorOperationChains` so operations on a rebuilding
 * coordinator await its rebuild, while operations on healthy coordinators
 * proceed independently.
 */
const refreshPromisesByCoordinator = new Map<string, Promise<void>>();

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

export function isCoordinatorClientRefreshInProgress(): boolean {
	return refreshPromisesByCoordinator.size > 0;
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

export function isTransientCoordinatorError(error: unknown): boolean {
	const detail = error instanceof Error ? error.message : String(error);
	return /timeout|timed out|connection closed|failed to publish event|relay rejected publish|network|disconnected/i.test(
		detail
	);
}

const SIGNER_READY_RETRY_ATTEMPTS = 3;
const SIGNER_READY_RETRY_DELAY_MS = 500;

export function isSignerUnavailableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /signer extension missing/i.test(message);
}

/**
 * Run a coordinator call, retrying on signer-not-ready errors. The NIP-46 /
 * extension signer can take a moment to become ready after account activation,
 * so a handful of bounded retries covers the cold-start window without
 * surfacing a spurious failure to the user.
 */
export async function withCoordinatorClientRetry<T>(
	account: IAccount,
	coordinatorKey: string,
	operation: (client: coordinatorClient) => Promise<T>
): Promise<T> {
	for (let attempt = 0; attempt <= SIGNER_READY_RETRY_ATTEMPTS; attempt += 1) {
		try {
			return await withCoordinatorClient(account, coordinatorKey, operation);
		} catch (error) {
			if (!isSignerUnavailableError(error) || attempt === SIGNER_READY_RETRY_ATTEMPTS) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, SIGNER_READY_RETRY_DELAY_MS));
		}
	}
	// Unreachable: the loop either returns or throws on the final attempt.
	throw new Error('Failed to complete coordinator request');
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
	const queued = previous
		.catch(() => undefined)
		.then(async () => {
			const refresh = refreshPromisesByCoordinator.get(chainKey);
			if (refresh) {
				await refresh.catch(() => undefined);
			}
			return operation();
		});
	try {
		return await queued;
	} finally {
		release();
		if (coordinatorOperationChains.get(chainKey) === tail) {
			coordinatorOperationChains.delete(chainKey);
		}
	}
}

export async function withCoordinatorClient<T>(
	account: IAccount,
	coordinatorKey: string,
	operation: (client: coordinatorClient) => Promise<T>
): Promise<T> {
	return runCoordinatorOperation(account, coordinatorKey, async () => {
		try {
			return await operation(getCoordinatorClient(account, coordinatorKey));
		} catch (error) {
			if (!isTransientCoordinatorError(error)) {
				throw error;
			}
			await replaceCoordinatorClient(coordinatorKey, account);
			return operation(getCoordinatorClient(account, coordinatorKey));
		}
	});
}

/**
 * Rebuild a single coordinator's client so subsequent calls use a fresh
 * socket. Rebuilding replaces the client in-place and disconnects the old one
 * locally (no network publishes), which is what makes this safe to use from
 * the resume path: tearing down an unhealthy socket via an abort publish would
 * hang indefinitely, since relay publishes retry forever until ACKed.
 *
 * Concurrent rebuilds for the same coordinator dedup onto a single in-flight
 * promise (tracked in `refreshPromisesByCoordinator`) so the operation chain
 * can await them without forcing a second disconnect.
 */
export async function replaceCoordinatorClient(
	coordinatorKey: string,
	account: IAccount | undefined = manager.getActive()
): Promise<void> {
	if (!account) {
		return;
	}

	const registry = accountClientRegistries.get(getAccountRegistryKey(account));
	if (!registry) {
		return;
	}

	const chainKey = getCoordinatorOperationKey(account, coordinatorKey);
	const existing = refreshPromisesByCoordinator.get(chainKey);
	if (existing) {
		return existing;
	}

	const oldClient = registry.replaceClient(coordinatorKey);
	if (!oldClient) {
		return;
	}

	const promise = oldClient.disconnect().finally(() => {
		if (refreshPromisesByCoordinator.get(chainKey) === promise) {
			refreshPromisesByCoordinator.delete(chainKey);
		}
	});
	refreshPromisesByCoordinator.set(chainKey, promise);
	return promise;
}
