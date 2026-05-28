import { browser } from '$app/environment';
import { manager } from '$lib/services/accountManager.svelte';
import {
	clearChatReconnectStatus,
	failChatReconnectStatus,
	setChatReconnectStatus
} from '$lib/services/chatReconnectStatus.svelte';
import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
import { cordnClient, type coordinatorClient } from '$lib/services/coordinatorClient';
import { relayActions } from '$lib/stores/relay-store.svelte';
import { normalizePubKey } from '$lib/utils';
import type { NostrSigner } from '@contextvm/sdk';
import type { IAccount } from 'applesauce-accounts';

type CoordinatorTarget = {
	serverPubkey: string;
	relays: string[];
};

function resolveCoordinatorTarget(coordinatorKey: string): CoordinatorTarget {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	const coordinator = getChatCoordinator(normalizedCoordinatorKey);
	const relays = coordinator?.relays ?? relayActions.getSelectedRelays();
	return {
		serverPubkey: normalizedCoordinatorKey,
		relays
	};
}

class AccountCoordinatorClientRegistry {
	private readonly clients = new Map<string, cordnClient>();
	private readonly coordinatorKeys = new Map<string, string>();

	constructor(private readonly signer: NostrSigner) {}

	getClient(coordinatorKey: string): cordnClient {
		const target = resolveCoordinatorTarget(coordinatorKey);
		const existingClient = this.clients.get(target.serverPubkey);

		if (existingClient) {
			this.coordinatorKeys.set(target.serverPubkey, coordinatorKey);
			return existingClient;
		}

		const client = new cordnClient({
			signer: this.signer,
			serverPubkey: target.serverPubkey,
			relays: target.relays
		} as ConstructorParameters<typeof cordnClient>[0]);

		this.clients.set(target.serverPubkey, client);
		this.coordinatorKeys.set(target.serverPubkey, coordinatorKey);
		return client;
	}

	listCoordinatorKeys(): string[] {
		return [...this.coordinatorKeys.values()];
	}

	primeClients(coordinatorKeys: Iterable<string>) {
		for (const coordinatorKey of coordinatorKeys) {
			this.getClient(coordinatorKey);
		}
	}

	async disconnect(): Promise<void> {
		await Promise.allSettled([...this.clients.values()].map((client) => client.disconnect()));
		this.clients.clear();
		this.coordinatorKeys.clear();
	}
}

const accountClientRegistries = new Map<string, AccountCoordinatorClientRegistry>();
let refreshActiveClientsPromise: Promise<void> | null = null;
let runtimeRecoveryPromise: Promise<void> | null = null;
let documentHiddenAt = 0;

type CoordinatorClientRefreshHandler = (refreshClients: () => Promise<void>) => Promise<void>;
const coordinatorClientRefreshHandlers = new Set<CoordinatorClientRefreshHandler>();

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
	return refreshActiveClientsPromise !== null || runtimeRecoveryPromise !== null;
}

export function onCoordinatorClientsRefresh(handler: CoordinatorClientRefreshHandler): () => void {
	coordinatorClientRefreshHandlers.add(handler);
	return () => coordinatorClientRefreshHandlers.delete(handler);
}

function getActiveRegistryCoordinatorKeys(): string[] {
	const account = manager.getActive();
	if (!account) {
		return [];
	}

	return accountClientRegistries.get(getAccountRegistryKey(account))?.listCoordinatorKeys() ?? [];
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

export function isTransientCoordinatorError(error: unknown): boolean {
	const detail = error instanceof Error ? error.message : String(error);
	return /timeout|timed out|connection closed|failed to publish event|relay rejected publish|network|disconnected/i.test(
		detail
	);
}

export async function withCoordinatorClient<T>(
	account: IAccount,
	coordinatorKey: string,
	operation: (client: coordinatorClient) => Promise<T>
): Promise<T> {
	try {
		return await operation(getCoordinatorClient(account, coordinatorKey));
	} catch (error) {
		if (!isTransientCoordinatorError(error)) {
			throw error;
		}

		await replaceActiveCoordinatorClients();
		return operation(getCoordinatorClient(account, coordinatorKey));
	}
}

async function replaceActiveCoordinatorClients(): Promise<void> {
	if (refreshActiveClientsPromise) {
		return;
	}

	const account = manager.getActive();
	if (!account) {
		return;
	}

	const registryKey = getAccountRegistryKey(account);
	const existingRegistry = accountClientRegistries.get(registryKey);
	if (!existingRegistry) {
		return;
	}

	const nextRegistry = new AccountCoordinatorClientRegistry(account.signer);
	nextRegistry.primeClients(existingRegistry.listCoordinatorKeys());
	accountClientRegistries.set(registryKey, nextRegistry);

	refreshActiveClientsPromise = existingRegistry.disconnect().finally(() => {
		refreshActiveClientsPromise = null;
	});

	void refreshActiveClientsPromise;
}

async function refreshActiveCoordinatorClients(): Promise<void> {
	const refreshClients = () => replaceActiveCoordinatorClients();
	const handlers = [...coordinatorClientRefreshHandlers];

	if (handlers.length === 0) {
		await refreshClients();
		return;
	}

	await Promise.allSettled(handlers.map((handler) => handler(refreshClients)));
}

export async function requestCoordinatorClientsRefresh(message = 'Reconnecting…'): Promise<void> {
	if (runtimeRecoveryPromise) {
		return runtimeRecoveryPromise;
	}

	const activeCoordinatorKeys = getActiveRegistryCoordinatorKeys();
	if (activeCoordinatorKeys.length === 0) {
		return;
	}

	setChatReconnectStatus({
		phase: 'checking',
		message: 'Checking connection…',
		activeCoordinatorKeys
	});

	runtimeRecoveryPromise = (async () => {
		try {
			setChatReconnectStatus({
				phase: 'reconnecting',
				message,
				activeCoordinatorKeys
			});
			await refreshActiveCoordinatorClients();
			clearChatReconnectStatus();
		} catch (error) {
			failChatReconnectStatus(
				error instanceof Error ? error.message : 'Failed to reconnect to coordinators'
			);
			throw error;
		} finally {
			runtimeRecoveryPromise = null;
		}
	})();

	return runtimeRecoveryPromise;
}

function shouldAttemptResumeRefresh(): boolean {
	if (typeof navigator === 'undefined') {
		return false;
	}

	const hiddenForMs = documentHiddenAt > 0 ? Date.now() - documentHiddenAt : 0;
	const isMobileHeuristic =
		navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches;
	return isMobileHeuristic && hiddenForMs >= 30000 && getActiveRegistryCoordinatorKeys().length > 0;
}

if (browser) {
	window.addEventListener('online', () => {
		void requestCoordinatorClientsRefresh();
	});

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') {
			documentHiddenAt = Date.now();
			return;
		}

		if (!shouldAttemptResumeRefresh()) {
			documentHiddenAt = 0;
			return;
		}

		documentHiddenAt = 0;
		void requestCoordinatorClientsRefresh();
	});

	window.addEventListener('pageshow', () => {
		if (!shouldAttemptResumeRefresh()) {
			return;
		}

		documentHiddenAt = 0;
		void requestCoordinatorClientsRefresh();
	});
}
