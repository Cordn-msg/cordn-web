import { createAddressLoader, createEventLoader } from 'applesauce-loaders/loaders';
import { commonRelays, metadataRelays, relayPool } from './relay-pool';
import { eventStore } from './eventStore';
import { getOutboxes } from 'applesauce-core/helpers';
import { kinds } from 'nostr-tools';
// Create address loader
export const addressLoader = createAddressLoader(relayPool, { eventStore });
export const eventLoader = createEventLoader(relayPool, {
	eventStore,
	extraRelays: commonRelays
});

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

	return [
		...new Set(
			getOutboxes(relayList)
				.map((relay) => relay.trim())
				.filter(Boolean)
		)
	];
};

export const getMetadataLookupRelays = (pubkey: string): string[] => {
	return [...new Set([...getUserRelayListFromStore(pubkey), ...metadataRelays])];
};
