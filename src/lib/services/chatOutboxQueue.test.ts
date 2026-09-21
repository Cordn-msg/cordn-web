import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Offline-outbox queue tests. The heavy seam (chatGroups.svelte — MLS
 * encrypt/post/persist) is fully mocked; storage runs on the real memory
 * backend (browser is false), so the durable-entry lifecycle is exercised
 * end to end: enqueue → attempt → transient/ambiguous/definitive outcomes →
 * confirm-before-retry → FIFO head-of-line blocking.
 */

const mocks = vi.hoisted(() => {
	class RemovedFromGroupError extends Error {
		constructor(groupId: string) {
			super(`You were removed from this group: ${groupId}`);
		}
	}
	return {
		RemovedFromGroupError,
		pubkey: 'aa'.repeat(32),
		sendMock: vi.fn(),
		getGroupMock: vi.fn(),
		listMessagesMock: vi.fn(),
		refreshMock: vi.fn(),
		removedMock: vi.fn(),
		poisonedMock: vi.fn()
	};
});

vi.mock('$app/environment', () => ({ browser: false }));

vi.mock('./accountManager.svelte', () => ({
	manager: {
		getActive: () => ({ pubkey: mocks.pubkey }),
		active$: { subscribe: () => ({ unsubscribe: () => {} }) }
	}
}));

vi.mock('./chatGroups.svelte', () => ({
	RemovedFromGroupError: mocks.RemovedFromGroupError,
	ensureGroupsLoaded: vi.fn(async () => {}),
	getChatGroup: (...args: unknown[]) => mocks.getGroupMock(...args),
	isChatGroupPoisoned: (...args: unknown[]) => mocks.poisonedMock(...args),
	isChatGroupRemoved: (...args: unknown[]) => mocks.removedMock(...args),
	listChatGroupMessages: (...args: unknown[]) => mocks.listMessagesMock(...args),
	sendChatGroupMessage: (input: unknown) => mocks.sendMock(input)
}));

vi.mock('./chatGroupWatch.svelte', () => ({
	refreshWatchedGroups: (...args: unknown[]) => mocks.refreshMock(...args)
}));

/** Fresh module registry per test: clean queue state, clean memory storage,
 *  clean $state projection. Mock behaviour is (re)armed by each test. */
async function freshModules() {
	vi.resetModules();
	let eventId = 0;
	mocks.sendMock.mockReset();
	mocks.sendMock.mockImplementation(async (input: { onSealed?: (id: string) => Promise<void> }) => {
		if (input.onSealed) await input.onSealed(`evt-${++eventId}`);
		return { cursor: 1, at: Date.now() };
	});
	mocks.getGroupMock.mockReset();
	mocks.getGroupMock.mockReturnValue({ id: 'g1', status: 'active' });
	mocks.removedMock.mockReset();
	mocks.removedMock.mockReturnValue(false);
	mocks.poisonedMock.mockReset();
	mocks.poisonedMock.mockReturnValue(false);
	mocks.listMessagesMock.mockReset();
	mocks.listMessagesMock.mockReturnValue([]);
	mocks.refreshMock.mockReset();
	mocks.refreshMock.mockResolvedValue(undefined);
	return {
		queue: await import('./chatOutboxQueue'),
		storage: await import('$lib/storage/chatStorage'),
		projection: await import('./chatOutbox.svelte')
	};
}

/** Wait for enqueue's persist→drain kick to land, then run (or join) a drain. */
async function settleDrain(queue: typeof import('./chatOutboxQueue')) {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await queue.requestDrain();
}

async function listEntries(storage: typeof import('$lib/storage/chatStorage')) {
	return storage.getChatStorage().then((s) => s.listOutboxEntries());
}

beforeEach(() => {
	vi.useRealTimers();
});

describe('offline outbox queue', () => {
	test('online send: entry persisted before the post, dropped after success', async () => {
		const { queue, storage, projection } = await freshModules();
		let sealedMarkerSeen: unknown = null;
		mocks.sendMock.mockImplementation(
			async (input: { onSealed?: (id: string) => Promise<void> }) => {
				if (input.onSealed) await input.onSealed('evt-1');
				// Inside the send (i.e. before the post resolves): the durable
				// marker must already be on disk so an ambiguous outcome is
				// resolvable. Attempt state is 'ambiguous' at this point by
				// design ("this id is about to be posted").
				const entries = await listEntries(storage);
				sealedMarkerSeen = entries.find((entry) => entry.attemptedEventId === 'evt-1');
				return { cursor: 1, at: Date.now() };
			}
		);

		queue.enqueueTextMessage({ groupId: 'g1', content: 'hello' });
		expect(projection.getPendingMessages('g1')[0]?.deliveryState).toBe('queued');
		expect(projection.getPendingMessages('g1')[0]?.text).toBe('hello');

		await settleDrain(queue);

		expect(mocks.sendMock).toHaveBeenCalledTimes(1);
		expect(sealedMarkerSeen).not.toBeNull();
		expect(await listEntries(storage)).toHaveLength(0);
		expect(projection.getPendingMessages('g1')).toHaveLength(0);
	});

	test('timeout marks ambiguous; a backlog confirm drops it without retry', async () => {
		const { queue, storage, projection } = await freshModules();
		mocks.sendMock.mockImplementation(
			async (input: { onSealed?: (id: string) => Promise<void> }) => {
				if (input.onSealed) await input.onSealed('evt-timeout');
				throw new Error('Coordinator request timed out after 8000ms');
			}
		);

		queue.enqueueTextMessage({ groupId: 'g1', content: 'flaky' });
		await settleDrain(queue);

		const entries = await listEntries(storage);
		expect(entries).toHaveLength(1);
		expect(entries[0].state).toBe('ambiguous');
		expect(entries[0].attemptedEventId).toBe('evt-timeout');
		// The bubble carries the attempted event id so the UI can hide it the
		// moment its confirmed copy lands (no both-visible flash).
		expect(projection.getPendingMessages('g1')[0]?.eventId).toBe('evt-timeout');
		expect(projection.getPendingMessages('g1')[0]?.deliveryState).toBe('queued');

		// The attempt actually landed: the backlog catch-up sees its event id.
		mocks.listMessagesMock.mockReturnValue([{ id: 'evt-timeout' }]);
		await settleDrain(queue);

		expect(mocks.refreshMock).toHaveBeenCalled();
		expect(mocks.sendMock).toHaveBeenCalledTimes(1); // never re-posted
		expect(await listEntries(storage)).toHaveLength(0);
		expect(projection.getPendingMessages('g1')).toHaveLength(0);
	});

	test('ambiguous-but-absent retries only after the backoff window', async () => {
		const { queue, storage } = await freshModules();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		mocks.sendMock.mockImplementation(
			async (input: { onSealed?: (id: string) => Promise<void> }) => {
				if (input.onSealed) await input.onSealed('evt-mia');
				throw new Error('Coordinator request timed out after 8000ms');
			}
		);

		queue.enqueueTextMessage({ groupId: 'g1', content: 'lost' });
		await settleDrain(queue);
		expect(mocks.sendMock).toHaveBeenCalledTimes(1);

		// Still inside the 15s backoff: no second attempt.
		await settleDrain(queue);
		expect(mocks.sendMock).toHaveBeenCalledTimes(1);
		expect((await listEntries(storage))[0].state).toBe('ambiguous');

		// Past the window: confirm sweep proves absence, then retries.
		vi.setSystemTime(Date.now() + 60_000);
		await settleDrain(queue);
		expect(mocks.sendMock).toHaveBeenCalledTimes(2);
	});

	test('transient head failure blocks the group FIFO (no out-of-order send)', async () => {
		const { queue, storage } = await freshModules();
		mocks.sendMock.mockRejectedValueOnce(new TypeError('fetch failed'));

		queue.enqueueTextMessage({ groupId: 'g1', content: 'first' });
		queue.enqueueTextMessage({ groupId: 'g1', content: 'second' });
		await settleDrain(queue);

		// Only the head was attempted; the second intent waits behind it.
		expect(mocks.sendMock).toHaveBeenCalledTimes(1);
		expect(mocks.sendMock.mock.calls[0][0]).toMatchObject({ content: 'first' });
		const entries = await listEntries(storage);
		expect(entries).toHaveLength(2);
		expect(entries[0].attempts).toBe(1);
		expect(entries[1].attempts).toBe(0);
	});

	test('removed group fails its entries without attempting', async () => {
		const { queue, storage, projection } = await freshModules();
		mocks.removedMock.mockReturnValue(true);

		queue.enqueueTextMessage({ groupId: 'g1', content: 'stranded' });
		await settleDrain(queue);

		expect(mocks.sendMock).not.toHaveBeenCalled();
		const entries = await listEntries(storage);
		expect(entries[0].state).toBe('failed');
		expect(projection.getPendingMessages('g1')[0]?.deliveryState).toBe('error');
	});

	test('retryOutboxEntry resets backoff and re-attempts immediately', async () => {
		const { queue, storage } = await freshModules();
		mocks.sendMock.mockRejectedValueOnce(new TypeError('fetch failed'));

		queue.enqueueTextMessage({ groupId: 'g1', content: 'again' });
		await settleDrain(queue);
		expect(mocks.sendMock).toHaveBeenCalledTimes(1);

		const [entry] = await listEntries(storage);
		queue.retryOutboxEntry(`outbox:${entry.seq}`);
		await settleDrain(queue);

		expect(mocks.sendMock).toHaveBeenCalledTimes(2);
		expect(await listEntries(storage)).toHaveLength(0);
	});

	test('hydrateOutbox rebuilds the projection from durable storage', async () => {
		const { queue, projection } = await freshModules();
		mocks.sendMock.mockRejectedValue(new TypeError('fetch failed'));

		queue.enqueueTextMessage({ groupId: 'g1', content: 'offline-1' });
		await settleDrain(queue);
		expect(projection.getPendingMessages('g1')).toHaveLength(1);

		// Simulate the UI losing its projection (reload / account switch): the
		// durable entry re-hydrates it from storage with the queued state.
		projection.replaceAllPending({});
		expect(projection.getPendingMessages('g1')).toHaveLength(0);
		await queue.hydrateOutbox();
		expect(projection.getPendingMessages('g1')).toHaveLength(1);
		expect(projection.getPendingMessages('g1')[0]?.text).toBe('offline-1');
		expect(projection.getPendingMessages('g1')[0]?.deliveryState).toBe('queued');
	});
});
