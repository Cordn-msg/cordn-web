import { RelayPool } from 'applesauce-relay';

// Create a single relay pool instance for the entire application
export const relayPool = new RelayPool();

export const defaultRelays = [
	'wss://relay.contextvm.org',
	'wss://relay2.contextvm.org',
	'wss://relay.primal.net'
];

export const commonRelays = [
	'wss://relay.damus.io',
	'wss://relay.nostr.net',
	'wss://relay.ditto.pub/',
	'wss://nos.lol',
	'wss://nostr.mom',
	'wss://relay.primal.net'
];

export const metadataRelays = [
	'wss://nos.lol',
	'wss://relay.damus.io',
	'wss://relay.ditto.pub/',
	'wss://relay.primal.net',
	'wss://relay.nostr.net',
	'wss://profiles.nostr1.com/',
	'wss://nostr.wine'
];

export const devRelay = ['ws://localhost:10547'];
