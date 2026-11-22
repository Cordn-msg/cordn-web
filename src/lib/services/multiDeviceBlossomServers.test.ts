import { beforeEach, describe, expect, test, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';

const { OWNER, localStorageMock, values, state, hooks } = vi.hoisted(() => {
	const OWNER = '11'.repeat(32);
	const values = new Map<string, string>();
	const localStorageMock = {
		getItem: vi.fn((key: string) => values.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => values.set(key, value)),
		removeItem: vi.fn((key: string) => values.delete(key)),
		clear: vi.fn(() => values.clear())
	};
	vi.stubGlobal('localStorage', localStorageMock);
	// The tip write parks until the test releases it, so a second plan can be
	// queued behind a publish that is still running. `tip` is what the relay
	// returns: whatever was published last.
	const state: {
		release: () => void;
		releaseRequest: () => void;
		holdNextRequest: boolean;
		accepted: unknown[];
		tip: unknown;
		tipWrites: number;
	} = {
		release: () => {},
		releaseRequest: () => {},
		holdNextRequest: false,
		accepted: [],
		tip: null,
		tipWrites: 0
	};
	const hooks = { address: (_sealed: string) => '' };
	return { OWNER, localStorageMock, values, state, hooks };
});

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: {
		getActive: () => ({
			pubkey: OWNER,
			// Only the inner tip needs an owner signature; the fake is enough here.
			signer: { signEvent: async (template: object) => ({ ...template, id: 'id', sig: 'sig' }) },
			nip44: { encrypt: async () => 'sealed', decrypt: async () => '{}' }
		})
	}
}));
vi.mock('$lib/services/relay-pool', () => ({
	commonRelays: [],
	relayPool: {
		request: () => ({
			subscribe: (observer: { next: (e: unknown) => void; complete: () => void }) => {
				const emit = () => {
					if (state.tip) observer.next(state.tip);
					observer.complete();
				};
				if (state.holdNextRequest) {
					state.holdNextRequest = false;
					void new Promise<void>((resolve) => (state.releaseRequest = resolve)).then(emit);
				} else emit();
				return { unsubscribe() {} };
			}
		}),
		subscription: () => ({ pipe: () => ({ subscribe: () => ({ unsubscribe() {} }) }) }),
		publish: async (_relays: string[], event: unknown) => {
			state.tipWrites++;
			await new Promise<void>((resolve) => (state.release = resolve));
			state.tip = event;
			return state.accepted;
		}
	}
}));
vi.mock('$lib/services/eventStore', () => ({
	eventStore: { addressable: () => ({ subscribe: () => ({ unsubscribe() {} }) }) }
}));
vi.mock('applesauce-core/observable', () => ({
	mapEventsToStore: () => (source: unknown) => source
}));
vi.mock('$lib/services/chatBlossomClient', () => ({
	uploadBlob: vi.fn(async ({ blob }: { blob: Uint8Array }) => ({
		sha256: hooks.address(new TextDecoder().decode(blob)),
		url: 'https://blossom.example/blob'
	})),
	fetchBlob: vi.fn(),
	deleteBlob: vi.fn()
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
	awaitMultiDeviceReconciled,
	DEFAULT_BLOSSOM_SERVERS,
	DEFAULT_MULTI_DEVICE_RELAYS,
	enableMultiDevice,
	mdConfigRevision,
	retryMultiDevicePublish,
	resetMultiDeviceSession,
	setMultiDeviceBlossomServers
} from './multiDevice.svelte';
import { documentAddress } from './multiDevice';

hooks.address = documentAddress;

/** Let every queued microtask (and the 0ms timers) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const LEGACY_HOSTS = [
	'https://cdn.hzrd149.com/',
	'https://blossom.ditto.pub/',
	'https://blossom.primal.net/'
];

describe('enableMultiDevice()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		values.clear();
		state.accepted = [{}];
		state.tip = null;
		state.tipWrites = 0;
		state.release = () => {};
		state.releaseRequest = () => {};
		state.holdNextRequest = false;
	});

	test('the first publish is not repeated by the startup restore/audit', async () => {
		const revision = mdConfigRevision.value;
		enableMultiDevice();
		await flush();
		state.release(); // let the initial publish finish
		await flush();

		// A second tip write is the whole 75-group reseal running twice: once for
		// enable, once for the pending plan the startup pass re-queued.
		expect(state.tipWrites).toBe(1);
		// Every persisted config write bumps the revision the page renders from.
		expect(mdConfigRevision.value).toBeGreaterThan(revision);

		resetMultiDeviceSession();
		state.release();
	});

	test('work stranded by a previous session still publishes and clears', async () => {
		const ephemeral = generateSecretKey();
		values.set(
			'cordn.multiDevice',
			JSON.stringify({
				[OWNER]: {
					ownerPubkey: OWNER,
					dTag: 'test',
					ephemeralPrivateKey: bytesToHex(ephemeral),
					ephemeralPubkey: getPublicKey(ephemeral),
					relays: ['wss://relay.example'],
					blossomServers: ['https://blossom.example/'],
					dekPrivateKey: bytesToHex(generateSecretKey()),
					pendingPublish: { resealGroups: 'all', resealMeta: true }
				}
			})
		);

		void awaitMultiDeviceReconciled();
		await flush();
		expect(state.tipWrites).toBe(1);
		state.release();
		await flush();

		const stored = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		expect(stored.pendingPublish).toBeUndefined();
		resetMultiDeviceSession();
	});

	test('a plan published during the startup reconcile is not restored again', async () => {
		state.holdNextRequest = true; // hold only the startup reconcile's tip read
		enableMultiDevice();
		await flush(); // initial publish is parked; startup is still reconciling
		state.release();
		await flush(); // initial publish finishes and clears its persisted plan
		state.releaseRequest();
		await flush();

		expect(state.tipWrites).toBe(1);

		resetMultiDeviceSession();
		state.release();
	});
});

describe('retryMultiDevicePublish()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		values.clear();
		state.accepted = [{}];
		state.tip = null;
		state.tipWrites = 0;
		state.release = () => {};
		state.releaseRequest = () => {};
		state.holdNextRequest = false;
	});

	test('reports nothing to do when no work is waiting', () => {
		values.set(
			'cordn.multiDevice',
			JSON.stringify({ [OWNER]: { ownerPubkey: OWNER, dTag: 'test' } })
		);

		expect(retryMultiDevicePublish()).toBe(false);
	});

	test('publishes a plan stranded by a previous session and clears it', async () => {
		const ephemeral = generateSecretKey();
		values.set(
			'cordn.multiDevice',
			JSON.stringify({
				[OWNER]: {
					ownerPubkey: OWNER,
					dTag: 'test',
					ephemeralPrivateKey: bytesToHex(ephemeral),
					ephemeralPubkey: getPublicKey(ephemeral),
					relays: ['wss://relay.example'],
					blossomServers: ['https://blossom.example/'],
					dekPrivateKey: bytesToHex(generateSecretKey()),
					pendingPublish: { resealGroups: 'all', resealMeta: true }
				}
			})
		);

		expect(retryMultiDevicePublish()).toBe(true);
		await flush();
		expect(state.tipWrites).toBe(1);
		state.release();
		await flush();

		const stored = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		expect(stored.pendingPublish).toBeUndefined();
		resetMultiDeviceSession();
	});
});

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

	test('a plan queued behind a running publish stays stored until it runs', async () => {
		const ephemeral = generateSecretKey();
		values.set(
			'cordn.multiDevice',
			JSON.stringify({
				[OWNER]: {
					ownerPubkey: OWNER,
					dTag: 'test',
					ephemeralPrivateKey: bytesToHex(ephemeral),
					ephemeralPubkey: getPublicKey(ephemeral),
					relays: ['wss://relay.example'],
					blossomServers: ['https://blossom.example/'],
					dekPrivateKey: bytesToHex(generateSecretKey())
				}
			})
		);
		state.accepted = [{}];
		state.tip = null;

		setMultiDeviceBlossomServers(['https://a.example/']);
		await flush(); // A is now parked at the tip write
		setMultiDeviceBlossomServers(['https://b.example/']);
		await flush(); // B is queued behind A

		state.release();
		await flush(); // A finished; B is parked at its own tip write

		// B has not been published by anyone yet: dropping it here loses the work.
		const stored = JSON.parse(values.get('cordn.multiDevice')!)[OWNER];
		expect(stored.pendingPublish).toEqual({ resealGroups: 'all', resealMeta: true });

		resetMultiDeviceSession();
		state.release();
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
