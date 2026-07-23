import { AccountManager } from 'applesauce-accounts';
import { registerAndroidAccounts } from 'applesauce-accounts/accounts/android-native-account';
import { NostrConnectSigner } from 'applesauce-signers/signers';
import { browser } from '$app/environment';
import { relayPool } from './relay-pool';

// create an account manager instance
export const manager = new AccountManager();

export const activeAccount = manager.active$;
// register account types. registerAndroidAccounts is a superset of the common set
// (it calls registerCommonAccountTypes) and additionally wires AndroidNativeAccount so a
// NIP-55 (Amber) login persisted to localStorage can rehydrate on relaunch.
registerAndroidAccounts(manager);

// Setup Nostr connect signer
NostrConnectSigner.subscriptionMethod = relayPool.subscription.bind(relayPool);
NostrConnectSigner.publishMethod = relayPool.publish.bind(relayPool);

// Client-side initialization
if (browser) {
	// first load all accounts from localStorage
	const json = JSON.parse(localStorage.getItem('accounts') || '[]');
	if (json.length) {
		manager.fromJSON(json);

		// load active account from storage. A stale `active` id (account that failed to rehydrate
		// or was removed) must not throw here and blank the whole app — drop the pointer and fall
		// through to the logged-out UI instead.
		const active = localStorage.getItem('active');
		if (active) {
			if (manager.getAccount(active)) manager.setActive(active);
			else localStorage.removeItem('active');
		}

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
