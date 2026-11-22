import { beforeEach, describe, expect, test, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('$lib/services/relay-pool', () => ({ relayPool: { request } }));
vi.mock('$lib/services/multiDevice.svelte', () => ({ MULTI_DEVICE_TIP_KIND: 30078 }));
vi.mock('$lib/services/multiDevice', () => ({
	isNewerTipEvent: (candidate: NostrEvent, current: NostrEvent) =>
		candidate.created_at > current.created_at
}));
vi.mock('$lib/services/chatBlossomClient', () => ({ hasBlob: vi.fn() }));

import { probeRelayTips } from '$lib/services/multiDeviceDev.svelte';

const secret = generateSecretKey();
const tip = finalizeEvent(
	{ kind: 30078, created_at: 1, tags: [['d', 'cordn']], content: '{}' },
	secret
);
const config = {
	ephemeralPubkey: tip.pubkey,
	dTag: 'cordn',
	relays: ['wss://relay.one']
} as never;

/** Drive the mocked subscription synchronously after `subscribe()` returns. */
function answer(run: (handlers: Record<string, (value?: never) => void>) => void) {
	request.mockReturnValue({
		subscribe: (handlers: Record<string, (value?: never) => void>) => {
			queueMicrotask(() => run(handlers));
			return { unsubscribe: vi.fn() };
		}
	});
}

describe('probeRelayTips', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('keeps the verified tip event when the relay answers', async () => {
		answer((handlers) => {
			handlers.next(tip as never);
			handlers.complete();
		});

		const [row] = await probeRelayTips(config);

		expect(row).toMatchObject({ relay: 'wss://relay.one', eventId: tip.id, event: tip });
		expect(row.reason).toBeUndefined();
	});

	test('reports a relay that answered with nothing as empty, not failed', async () => {
		answer((handlers) => handlers.complete());

		const [row] = await probeRelayTips(config);

		expect(row.eventId).toBeNull();
		expect(row.reason).toBeUndefined();
	});

	test('reports a relay error as a failed probe, not an empty relay', async () => {
		answer((handlers) => handlers.error(new Error('connection lost') as never));

		const [row] = await probeRelayTips(config);

		expect(row.eventId).toBeNull();
		expect(row.reason).toBe('connection lost');
	});
});
