import { beforeEach, describe, expect, test, vi } from 'vitest';

const { OWNER, localStorageMock, values } = vi.hoisted(() => {
	const OWNER = '11'.repeat(32);
	const values = new Map<string, string>();
	const localStorageMock = {
		getItem: vi.fn((key: string) => values.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => values.set(key, value)),
		removeItem: vi.fn((key: string) => values.delete(key)),
		clear: vi.fn(() => values.clear())
	};
	vi.stubGlobal('localStorage', localStorageMock);
	return { OWNER, localStorageMock, values };
});

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { getActive: () => ({ pubkey: OWNER }) }
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

import {
	adoptDefaultBlossomServers,
	adoptDefaultRelays,
	adoptFleetBlossomServers,
	DEFAULT_BLOSSOM_SERVERS,
	DEFAULT_MULTI_DEVICE_RELAYS,
	resetMultiDeviceSession,
	setMultiDeviceBlossomServers
} from './multiDevice.svelte';

const LEGACY_HOSTS = [
	'https://cdn.hzrd149.com/',
	'https://blossom.ditto.pub/',
	'https://blossom.primal.net/'
];

describe('setMultiDeviceBlossomServers()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		values.set(
			'cordn.multiDevice',
			JSON.stringify({
				[OWNER]: {
					ownerPubkey: OWNER,
					dTag: 'test',
					blossomServers: [...DEFAULT_BLOSSOM_SERVERS]
				}
			})
		);
	});

	test('an unchanged normalized host list does not save or schedule a bulk publish', () => {
		setMultiDeviceBlossomServers(['', ...DEFAULT_BLOSSOM_SERVERS, DEFAULT_BLOSSOM_SERVERS[0]]);

		expect(localStorageMock.setItem).not.toHaveBeenCalled();
	});

	test('a host change persists the bulk plan before any network work', () => {
		setMultiDeviceBlossomServers(['https://blossom.example/']);
		const stored = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		expect(stored.pendingPublish).toEqual({ resealGroups: 'all', resealMeta: true });
		resetMultiDeviceSession();
	});

	test('a publish that could not run keeps its plan for the next trigger', async () => {
		setMultiDeviceBlossomServers(['https://blossom.example/']);
		// Let the scheduled flush run: no signer here, so nothing is published.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const stored = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		expect(stored.pendingPublish).toEqual({ resealGroups: 'all', resealMeta: true });
		resetMultiDeviceSession();
	});

	test('a save from a snapshot taken before the plan keeps the stored plan', () => {
		setMultiDeviceBlossomServers(['https://blossom.example/']);
		// A publish that started earlier holds a config parsed before the plan.
		const stale = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		delete stale.pendingPublish;

		adoptFleetBlossomServers(stale, ['https://other.example/']);

		const stored = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		expect(stored.pendingPublish).toEqual({ resealGroups: 'all', resealMeta: true });
		resetMultiDeviceSession();
	});
});

describe('adoptDefaultBlossomServers()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function stored(servers: string[]): void {
		values.set(
			'cordn.multiDevice',
			JSON.stringify({
				[OWNER]: { ownerPubkey: OWNER, dTag: 'test', blossomServers: servers }
			})
		);
	}

	function read(): string[] {
		return JSON.parse(values.get('cordn.multiDevice')!)[OWNER].blossomServers;
	}

	test('moves either untouched legacy default list onto the Cordn default', () => {
		stored(LEGACY_HOSTS);
		const config = { ownerPubkey: OWNER, dTag: 'test', blossomServers: [...LEGACY_HOSTS] };

		expect(adoptDefaultBlossomServers(config as never)).toBe(true);
		expect(config.blossomServers).toEqual([...DEFAULT_BLOSSOM_SERVERS]);
		expect(read()).toEqual([...DEFAULT_BLOSSOM_SERVERS]);
	});

	test('migrates the previous four-host default too', () => {
		const previous = [
			'https://cordn.feeds.relay.tools/',
			'https://cdn.hzrd149.com/',
			'https://blossom.ditto.pub/',
			'https://blossom.primal.net/'
		];
		stored(previous);
		const config = { ownerPubkey: OWNER, dTag: 'test', blossomServers: [...previous] };

		expect(adoptDefaultBlossomServers(config as never)).toBe(true);
		expect(read()).toEqual([...DEFAULT_BLOSSOM_SERVERS]);
	});

	test('leaves a hand-picked host list alone', () => {
		const custom = ['https://blossom.ditto.pub/', 'https://cdn.hzrd149.com/'];
		stored(custom);
		const config = { ownerPubkey: OWNER, dTag: 'test', blossomServers: [...custom] };

		expect(adoptDefaultBlossomServers(config as never)).toBe(false);
		expect(read()).toEqual(custom);
	});

	test('is a no-op once the current default is stored', () => {
		stored([...DEFAULT_BLOSSOM_SERVERS]);
		const config = {
			ownerPubkey: OWNER,
			dTag: 'test',
			blossomServers: [...DEFAULT_BLOSSOM_SERVERS]
		};

		expect(adoptDefaultBlossomServers(config as never)).toBe(false);
	});
});

describe('fleet configuration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		values.set(
			'cordn.multiDevice',
			JSON.stringify({
				[OWNER]: {
					ownerPubkey: OWNER,
					dTag: 'test',
					relays: ['wss://relay.nostr.net', 'wss://relay.ditto.pub/', 'wss://relay.primal.net'],
					blossomServers: [...DEFAULT_BLOSSOM_SERVERS]
				}
			})
		);
	});

	test('migrates only the exact old relay default', () => {
		const config = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		expect(adoptDefaultRelays(config)).toBe(true);
		expect(config.relays).toEqual(DEFAULT_MULTI_DEVICE_RELAYS);
		expect(adoptDefaultRelays(config)).toBe(false);
	});

	test('adopts the signed tip fleet hosts, normalized and deduplicated', () => {
		const config = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		expect(
			adoptFleetBlossomServers(config, [
				' https://one.example/ ',
				'https://one.example',
				'not-a-url'
			])
		).toBe(true);
		expect(config.blossomServers).toEqual(['https://one.example/']);
		expect(adoptFleetBlossomServers(config, ['https://one.example'])).toBe(false);
		expect(adoptFleetBlossomServers(config, ['not-a-url'])).toBe(false);
	});
});
