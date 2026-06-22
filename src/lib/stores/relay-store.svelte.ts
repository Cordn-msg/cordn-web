import { dev } from '$app/environment';
import { defaultRelays, devRelay } from '../services/relay-pool';

// Reactive relay store using Svelte 5 $state.
// Consumers that need to react to relay changes should `$effect`/`$derived` on
// `relayStore.selectedRelays` directly — no imperative callback needed.
export const relayStore = $state({
	selectedRelays: dev ? devRelay : defaultRelays
});

// Helper functions to manage the relay store
export const relayActions = {
	// Update selected relays
	setSelectedRelays: (relays: string[]) => {
		relayStore.selectedRelays = relays;
	},

	// Get current selected relays
	getSelectedRelays: (): string[] => {
		return relayStore.selectedRelays;
	},

	// Reset to default relays
	resetToDefaultRelays: () => {
		relayActions.setSelectedRelays(defaultRelays);
	},

	// Use dev relay
	useDevRelay: () => {
		relayActions.setSelectedRelays(devRelay);
	},

	// Remove relays from selected relays
	removeRelays: (relaysToRemove: string[]) => {
		const filteredRelays = relayStore.selectedRelays.filter(
			(relay) =>
				!relaysToRemove.some(
					(relayToRemove) => relay.startsWith(relayToRemove) || relayToRemove.startsWith(relay)
				)
		);
		relayActions.setSelectedRelays(filteredRelays);
	}
};
