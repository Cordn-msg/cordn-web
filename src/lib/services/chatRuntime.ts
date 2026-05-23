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

	constructor(private readonly signer: NostrSigner) {}

	getClient(coordinatorKey: string): cordnClient {
		const target = resolveCoordinatorTarget(coordinatorKey);
		const existingClient = this.clients.get(target.serverPubkey);

		if (existingClient) {
			return existingClient;
		}

		const client = new cordnClient({
			signer: this.signer,
			serverPubkey: target.serverPubkey,
			relays: target.relays
		} as ConstructorParameters<typeof cordnClient>[0]);

		this.clients.set(target.serverPubkey, client);
		return client;
	}

	async disconnect(): Promise<void> {
		await Promise.allSettled([...this.clients.values()].map((client) => client.disconnect()));
		this.clients.clear();
	}
}

const accountClientRegistries = new Map<string, AccountCoordinatorClientRegistry>();
let disconnectActiveClientsPromise: Promise<void> | null = null;

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

async function disconnectActiveCoordinatorClients(): Promise<void> {
	if (disconnectActiveClientsPromise) {
		return disconnectActiveClientsPromise;
	}

	disconnectActiveClientsPromise = disconnectCoordinatorClients().finally(() => {
		disconnectActiveClientsPromise = null;
	});

	return disconnectActiveClientsPromise;
}

if (browser) {
	const invalidateActiveCoordinatorClients = () => {
		console.log('invalidating active coordinator clients');
		void disconnectActiveCoordinatorClients();
	};

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			invalidateActiveCoordinatorClients();
		}
	});

	window.addEventListener('pageshow', invalidateActiveCoordinatorClients);
	window.addEventListener('online', invalidateActiveCoordinatorClients);
}
