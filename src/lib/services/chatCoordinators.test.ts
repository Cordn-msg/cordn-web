import { describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { getActive: () => undefined, active: undefined }
}));
vi.mock('$lib/services/chatGroups.svelte', () => ({
	listChatGroups: () => []
}));
vi.mock('$lib/services/chatKeyPackages.svelte', () => ({
	listChatKeyPackages: () => []
}));

import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
import { defaultRelays } from '$lib/services/relay-pool';
import {
	ensureDefaultCoordinatorRelays,
	getChatCoordinator,
	markCoordinatorRelaysResolved,
	markCoordinatorUsed,
	upsertChatCoordinator
} from './chatCoordinators.svelte';

describe('ensureDefaultCoordinatorRelays', () => {
	test('fills a relay-less default entry; leaves existing relays alone', () => {
		// Relay-less default entry (install seeded before relays): filled.
		upsertChatCoordinator({
			pubkey: DEFAULT_CHAT_COORDINATOR_PUBKEY,
			label: 'Default coordinator'
		});
		ensureDefaultCoordinatorRelays();
		expect(getChatCoordinator(DEFAULT_CHAT_COORDINATOR_PUBKEY)?.relays).toEqual(defaultRelays);

		// User-set relays always win — never overwritten.
		const pinned = ['wss://pinned.example.com'];
		upsertChatCoordinator({ pubkey: DEFAULT_CHAT_COORDINATOR_PUBKEY, relays: pinned });
		ensureDefaultCoordinatorRelays();
		expect(getChatCoordinator(DEFAULT_CHAT_COORDINATOR_PUBKEY)?.relays).toEqual(pinned);
	});
});

describe('markCoordinatorRelaysResolved (SDK-resolved persistence, fill-if-empty)', () => {
	const resolved = ['wss://discovered.example.com', 'wss://discovered2.example.com'];

	test('fills a known relay-less coordinator; never creates an unknown one', () => {
		const known = 'ee'.repeat(32);
		markCoordinatorUsed(known); // stored without relays
		markCoordinatorRelaysResolved(known, resolved);
		expect(getChatCoordinator(known)?.relays).toEqual(resolved);

		// Unknown coordinator (e.g. removed while its client was resolving): no entry.
		const unknown = 'ff'.repeat(32);
		markCoordinatorRelaysResolved(unknown, resolved);
		expect(getChatCoordinator(unknown)).toBeUndefined();
	});

	test('never overwrites user-set or hint-adopted relays; ignores empty results', () => {
		const key = 'ab'.repeat(32);
		const pinned = ['wss://pinned.example.com'];
		upsertChatCoordinator({ pubkey: key, relays: pinned });
		markCoordinatorRelaysResolved(key, resolved);
		expect(getChatCoordinator(key)?.relays).toEqual(pinned);

		const hintAdopted = 'cd'.repeat(32);
		markCoordinatorUsed(hintAdopted, resolved); // document hints adopted
		markCoordinatorRelaysResolved(hintAdopted, ['wss://other.example.com']);
		expect(getChatCoordinator(hintAdopted)?.relays).toEqual(resolved);

		const bare = 'ef'.repeat(32);
		markCoordinatorUsed(bare);
		markCoordinatorRelaysResolved(bare, []);
		expect(getChatCoordinator(bare)?.relays).toEqual([]);
	});
});

describe('markCoordinatorUsed relay-hint adoption (spec §4.1/§9)', () => {
	const hints = ['wss://relay.example.com', 'wss://backup.example.com'];

	test('document hints fill a brand-new coordinator entry', () => {
		const key = 'aa'.repeat(32);
		markCoordinatorUsed(key, hints);
		expect(getChatCoordinator(key)?.relays).toEqual(hints);
	});

	test('document hints fill an existing relay-less entry (adopted earlier without hints)', () => {
		const key = 'bb'.repeat(32);
		markCoordinatorUsed(key); // first adoption: no hints in the document
		expect(getChatCoordinator(key)?.relays).toEqual([]);
		markCoordinatorUsed(key, hints); // later fast-forward carries hints
		expect(getChatCoordinator(key)?.relays).toEqual(hints);
	});

	test('locally configured relays always win over document hints', () => {
		const key = 'cc'.repeat(32);
		const local = ['wss://manually-fixed.example.com'];
		upsertChatCoordinator({ pubkey: key, relays: local });
		markCoordinatorUsed(key, hints);
		expect(getChatCoordinator(key)?.relays).toEqual(local);
	});

	test('empty or absent hints are a no-op', () => {
		const key = 'dd'.repeat(32);
		markCoordinatorUsed(key, []);
		markCoordinatorUsed(key);
		expect(getChatCoordinator(key)?.relays).toEqual([]);
	});
});

describe('upsertChatCoordinator label semantics', () => {
	test('undefined label preserves a user-set label; blank label resets to the auto default', () => {
		const key = 'ab'.repeat(32);
		upsertChatCoordinator({ pubkey: key, label: 'My relay' });
		// Pubkey-only touch (profile start-chat, share-link registration) must not
		// clobber the user's label.
		upsertChatCoordinator({ pubkey: key });
		expect(getChatCoordinator(key)?.label).toBe('My relay');
		// Explicit blank (edit-form clear) falls back to the auto default so
		// getCoordinatorLabel can prefer the server-announced name again.
		upsertChatCoordinator({ pubkey: key, label: '   ' });
		expect(getChatCoordinator(key)?.label).toBe(`Coordinator ${key.slice(0, 8)}`);
	});
});
