import { AccountManager } from 'applesauce-accounts';
import { registerCommonAccountTypes } from 'applesauce-accounts/accounts';
import { NostrConnectSigner } from 'applesauce-signers/signers';
import { browser } from '$app/environment';
import { relayPool } from './relay-pool';

// create an account manager instance
export const manager = new AccountManager();

export const activeAccount = manager.active$;
// register common account types
registerCommonAccountTypes(manager);

// Setup Nostr connect signer
NostrConnectSigner.subscriptionMethod = relayPool.subscription.bind(relayPool);
NostrConnectSigner.publishMethod = relayPool.publish.bind(relayPool);

// Client-side initialization
if (browser) {
	// first load all accounts from localStorage
	const json = JSON.parse(localStorage.getItem('accounts') || '[]');
	if (json.length) {
		manager.fromJSON(json);

		// load active account from storage
		const active = localStorage.getItem('active');
		if (active) manager.setActive(active);

		// subscribe to active changes
	}
	manager.active$.subscribe((account) => {
		if (account) localStorage.setItem('active', account.id);
		else localStorage.removeItem('active');
	});
	// next, subscribe to any accounts added or removed
	manager.accounts$.subscribe(() => {
		// save all the accounts into the "accounts" field
		localStorage.setItem('accounts', JSON.stringify(manager.toJSON()));
	});
}

export const logout = () => {
	// if (browser) {
	// 	localStorage.removeItem('accounts');
	// }
	manager.clearActive();
};
