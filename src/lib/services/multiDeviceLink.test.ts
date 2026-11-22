import { beforeEach, describe, expect, test, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

const { OWNER, values, state } = vi.hoisted(() => {
	const OWNER = '11'.repeat(32);
	const values = new Map<string, string>();
	const state: { tip: unknown } = { tip: null };
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
		clear: () => values.clear()
	});
	return { OWNER, values, state };
});

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: {
		getActive: () => ({
			pubkey: OWNER,
			// A signer that cannot open the tip: the wrong-account case.
			nip44: {
				encrypt: async () => '',
				decrypt: async () => {
					throw new Error('not our seal');
				}
			}
		})
	}
}));
vi.mock('$lib/services/relay-pool', () => ({
	commonRelays: [],
	relayPool: {
		request: () => ({
			subscribe: (observer: { next: (e: unknown) => void; complete: () => void }) => {
				if (state.tip) observer.next(state.tip);
				observer.complete();
				return { unsubscribe() {} };
			}
		}),
		subscription: () => ({ pipe: () => ({ subscribe: () => ({ unsubscribe() {} }) }) }),
		publish: async () => []
	}
}));
vi.mock('$lib/services/eventStore', () => ({
	eventStore: { addressable: () => ({ subscribe: () => ({ unsubscribe() {} }) }) }
}));
vi.mock('applesauce-core/observable', () => ({
	mapEventsToStore: () => (source: unknown) => source
}));
vi.mock('$lib/services/chatGroups.svelte', () => ({
	listChatGroups: vi.fn(() => []),
	getChatGroup: vi.fn(),
	persistGroup: vi.fn(),
	replaceGroup: vi.fn(),
	deleteChatGroup: vi.fn(),
	decodeStoredGroupState: vi.fn(),
	runGroupOperation: vi.fn()
}));
vi.mock('$lib/services/chatKeyPackages.svelte', () => ({
	getLastResortKeyPackageEntry: vi.fn(),
	getLastResortKeyPackageRef: vi.fn(),
	loadLastResortKeyPackage: vi.fn(),
	repairLastResortAlignment: vi.fn(),
	setLastResortClaimBaseline: vi.fn()
}));

import { linkDeviceFromConnectionString, resetMultiDeviceSession } from './multiDevice.svelte';

/** A tip signed by `sk`, plus a connection string pointing at it. */
function tipFor(dTag: string): { connection: string; event: unknown } {
	const sk = generateSecretKey();
	const pubkey = getPublicKey(sk);
	const event = finalizeEvent(
		{ kind: 30078, created_at: 1, tags: [['d', dTag]], content: 'sealed' },
		sk
	);
	const naddr = nip19.naddrEncode({ kind: 30078, pubkey, identifier: dTag, relays: [] });
	const connection = btoa(JSON.stringify({ naddr, ephemeralPrivateKey: '22'.repeat(32) }));
	return { connection, event };
}

function stored(): Record<string, { dTag: string }> {
	return JSON.parse(values.get('cordn.multiDevice') ?? '{}');
}

describe('linkDeviceFromConnectionString()', () => {
	beforeEach(() => {
		values.clear();
		state.tip = null;
	});

	test('a tip this account cannot open leaves no config behind', async () => {
		const { connection, event } = tipFor('d1');
		state.tip = event;

		await expect(linkDeviceFromConnectionString(connection)).rejects.toThrow('different account');

		expect(stored()[OWNER]).toBeUndefined();
	});

	test('a peer with no tip yet reports waiting, not a synced link', async () => {
		state.tip = null;
		const { connection } = tipFor('d1');

		const result = await linkDeviceFromConnectionString(connection);

		// Zero seeded groups must not read as success: nothing was adopted.
		expect(result.foundTip).toBe(false);
		expect(result.seeded).toBe(0);
		expect(stored()[OWNER]?.dTag).toBe('d1');
		resetMultiDeviceSession();
	});

	test('a rejected re-link restores the config this device already had', async () => {
		values.set(
			'cordn.multiDevice',
			JSON.stringify({
				[OWNER]: {
					ownerPubkey: OWNER,
					dTag: 'old',
					ephemeralPrivateKey: '33'.repeat(32),
					ephemeralPubkey: '44'.repeat(32),
					relays: ['wss://relay.example'],
					blossomServers: ['https://blossom.example/']
				}
			})
		);
		const { connection, event } = tipFor('d2');
		state.tip = event;

		await expect(linkDeviceFromConnectionString(connection)).rejects.toThrow('different account');

		expect(stored()[OWNER].dTag).toBe('old');
		resetMultiDeviceSession();
	});
});
