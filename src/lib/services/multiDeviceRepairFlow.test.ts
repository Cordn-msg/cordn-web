import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools';

const {
	probeRelayTips,
	probeBlossomTip,
	readMultiDeviceTipEvent,
	ephemeralSigner,
	publish,
	fetchBlob,
	uploadBlob
} = vi.hoisted(() => ({
	probeRelayTips: vi.fn(),
	probeBlossomTip: vi.fn(),
	readMultiDeviceTipEvent: vi.fn(),
	ephemeralSigner: vi.fn(),
	publish: vi.fn(),
	fetchBlob: vi.fn(),
	uploadBlob: vi.fn()
}));

vi.mock('$lib/services/multiDeviceDev.svelte', () => ({ probeRelayTips, probeBlossomTip }));
vi.mock('$lib/services/multiDevice.svelte', () => ({ readMultiDeviceTipEvent, ephemeralSigner }));
vi.mock('$lib/services/multiDevice', () => ({
	documentAddress: () => 'doc',
	isNewerTipEvent: (candidate: NostrEvent, current: NostrEvent) =>
		candidate.created_at > current.created_at
}));
vi.mock('$lib/services/relay-pool', () => ({ relayPool: { publish } }));
vi.mock('$lib/services/chatBlossomClient', () => ({ fetchBlob, uploadBlob }));

import {
	checkMultiDeviceHealth,
	repairMultiDeviceHealth
} from '$lib/services/multiDeviceRepair.svelte';

const config = {
	ownerPubkey: 'aa'.repeat(32),
	ephemeralPubkey: 'bb'.repeat(32),
	dTag: 'cordn',
	relays: ['wss://relay.one', 'wss://relay.two'],
	blossomServers: ['https://blossom.one/'],
	lastSeenTip: null
} as never;
const newest = { id: 'new', created_at: 2 } as NostrEvent;
const older = { id: 'old', created_at: 1 } as NostrEvent;
const pointer = {
	groups: [{ address: 'doc', gid: 'gid' }],
	servers: ['https://blossom.two/']
};

function blob(server: string, present: boolean, status = present ? 200 : 404) {
	return {
		server,
		address: 'doc',
		kind: 'group' as const,
		gid: 'gid',
		present,
		status,
		size: null
	};
}

describe('multi-device health and repair', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		readMultiDeviceTipEvent.mockResolvedValue(pointer);
		ephemeralSigner.mockReturnValue('owner-signer');
	});

	test('checks the newest tip and every advertised document host', async () => {
		probeRelayTips.mockResolvedValue([
			{ relay: 'wss://relay.one', eventId: 'new', createdAt: 2, event: newest },
			{ relay: 'wss://relay.two', eventId: 'old', createdAt: 1, event: older }
		]);
		probeBlossomTip.mockResolvedValue([
			blob('https://blossom.one', true),
			blob('https://blossom.two', false)
		]);

		const health = await checkMultiDeviceHealth(config);

		expect(health.tipEvent).toBe(newest);
		expect(health.servers).toEqual(['https://blossom.two', 'https://blossom.one']);
		expect(health.missing).toEqual([blob('https://blossom.two', false)]);
	});

	test('re-broadcasts the same tip and mirrors an existing document without creating state', async () => {
		probeRelayTips
			.mockResolvedValueOnce([
				{ relay: 'wss://relay.one', eventId: 'new', createdAt: 2, event: newest },
				{ relay: 'wss://relay.two', eventId: 'old', createdAt: 1, event: older }
			])
			.mockResolvedValueOnce([
				{ relay: 'wss://relay.one', eventId: 'new', createdAt: 2, event: newest },
				{ relay: 'wss://relay.two', eventId: 'new', createdAt: 2, event: newest }
			]);
		probeBlossomTip
			.mockResolvedValueOnce([
				blob('https://blossom.one', true),
				blob('https://blossom.two', false)
			])
			.mockResolvedValueOnce([
				blob('https://blossom.one', true),
				blob('https://blossom.two', true)
			]);
		publish.mockResolvedValue([{ ok: true, from: 'wss://relay.two' }]);
		fetchBlob.mockResolvedValue(new TextEncoder().encode('sealed'));
		uploadBlob.mockResolvedValue({ sha256: 'doc', url: 'https://blossom.two/doc' });

		const result = await repairMultiDeviceHealth(config);

		expect(publish).toHaveBeenCalledWith(['wss://relay.two'], newest, { timeout: 5000 });
		expect(uploadBlob).toHaveBeenCalledWith({
			serverUrl: 'https://blossom.two',
			blob: new TextEncoder().encode('sealed'),
			signer: 'owner-signer',
			signal: expect.any(AbortSignal)
		});
		expect(ephemeralSigner).toHaveBeenCalledWith(config);
		expect(result.summary).toBe('Restored 2 missing copies');
	});

	test('never publishes to a relay whose probe failed', async () => {
		probeRelayTips.mockResolvedValue([
			{ relay: 'wss://relay.one', eventId: 'new', createdAt: 2, event: newest },
			{ relay: 'wss://relay.two', eventId: null, createdAt: null, event: null, reason: 'timeout' }
		]);
		probeBlossomTip.mockResolvedValue([
			blob('https://blossom.one', true),
			blob('https://blossom.two', true)
		]);

		const result = await repairMultiDeviceHealth(config);

		expect(publish).not.toHaveBeenCalled();
		expect(result.summary).toContain('1 relay(s) could not be checked');
	});
});
