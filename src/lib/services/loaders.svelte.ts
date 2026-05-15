import { createAddressLoader, createEventLoader } from 'applesauce-loaders/loaders';
import { commonRelays, relayPool } from './relay-pool';
import { eventStore } from './eventStore';

// Create address loader
export const addressLoader = createAddressLoader(relayPool, { eventStore });
export const eventLoader = createEventLoader(relayPool, {
	eventStore,
	extraRelays: commonRelays
});
