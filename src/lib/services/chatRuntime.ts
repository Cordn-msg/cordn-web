import { browser } from '$app/environment';
import { manager } from '$lib/services/accountManager.svelte';
import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
import { cordnClient } from '$lib/services/coordinatorClient';
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

export function onCoordinatorClientsRefresh(handler: CoordinatorClientRefreshHandler): () => void {
	coordinatorClientRefreshHandlers.add(handler);
	return () => coordinatorClientRefreshHandlers.delete(handler);
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

async function replaceActiveCoordinatorClients(): Promise<void> {
	if (refreshActiveClientsPromise) {
		return refreshActiveClientsPromise;
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

	return refreshActiveClientsPromise;
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

if (browser) {
	window.addEventListener('online', () => {
		void refreshActiveCoordinatorClients();
	});
}
