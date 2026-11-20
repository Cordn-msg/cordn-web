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
	DEFAULT_BLOSSOM_SERVERS,
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

	test('moves an untouched legacy default list onto the Cordn default', () => {
		stored(LEGACY_HOSTS);
		const config = { ownerPubkey: OWNER, dTag: 'test', blossomServers: [...LEGACY_HOSTS] };

		expect(adoptDefaultBlossomServers(config as never)).toBe(true);
		expect(config.blossomServers).toEqual([...DEFAULT_BLOSSOM_SERVERS]);
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
