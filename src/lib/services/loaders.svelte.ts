import { createAddressLoader } from 'applesauce-loaders/loaders';
import { metadataRelays, relayPool } from './relay-pool';
import { eventStore } from './eventStore';
import { getOutboxes } from 'applesauce-core/helpers';
import { kinds } from 'nostr-tools';
import { SvelteSet } from 'svelte/reactivity';
// Create address loader
export const addressLoader = createAddressLoader(relayPool, { eventStore });

export const createUserRelayListByPubkeyLoader = (pubkey: string, relays?: string[]) => {
	const selectedRelays = relays || metadataRelays;
	return addressLoader({
		pubkey,
		kind: kinds.RelayList,
		relays: selectedRelays
	});
};

export const getUserRelayListFromStore = (pubkey: string): string[] => {
	const relayList = eventStore.getReplaceable(kinds.RelayList, pubkey);
	if (!relayList) return [];
	const uniqueRelays = new SvelteSet(
		getOutboxes(relayList)
			.map((relay) => relay.trim())
			.filter(Boolean)
	);

	return [...uniqueRelays];
};
