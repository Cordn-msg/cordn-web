import { dev } from '$app/environment';
import { defaultRelays, devRelay } from '../services/relay-pool';

// Reactive relay store using Svelte 5 $state
export const relayStore = $state({
	selectedRelays: dev ? devRelay : defaultRelays,
	relayChangeCallback: null as ((relays: string[]) => void) | null
});

// Helper functions to manage the relay store
export const relayActions = {
	// Register a callback for relay changes
	onRelayChange: (callback: (relays: string[]) => void): (() => void) => {
		relayStore.relayChangeCallback = callback;

		// Return a function to unregister the callback
		return () => {
			relayStore.relayChangeCallback = null;
		};
	},

	// Update selected relays
	setSelectedRelays: (relays: string[]) => {
		relayStore.selectedRelays = relays;

		// Notify the registered callback
		if (relayStore.relayChangeCallback) {
			relayStore.relayChangeCallback(relays);
		}
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
