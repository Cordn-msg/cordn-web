import { afterEach, describe, expect, test, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools';
import { queryClient } from '$lib/query-client';
import { ensureProfileLoaded } from './chatProfileQueries';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/services/relay-pool', () => ({ metadataRelays: ['wss://meta.test'] }));

/** One controllable loader per pubkey: `complete()` is the relay round trip ending. */
const loader = vi.hoisted(() => ({ calls: [] as string[], complete: () => {} }));
vi.mock('$lib/services/loaders.svelte', () => ({
	addressLoader: (opts: { pubkey: string }) => ({
		subscribe(observer?: { complete?: () => void }) {
			loader.calls.push(opts.pubkey);
			loader.complete = () => observer?.complete?.();
			return { unsubscribe: () => {} };
		}
	}),
	createUserRelayListByPubkeyLoader: () => ({ subscribe: () => ({ unsubscribe: () => {} }) })
}));

const local = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (key: string) => local.get(key) ?? null,
	setItem: (key: string, value: string) => local.set(key, value),
	removeItem: (key: string) => local.delete(key)
});

const STORAGE_KEY = 'cordn.profile-cache';
const HOUR = 60 * 60 * 1000;

function metadata(name: string): NostrEvent {
	return finalizeEvent(
		{
			kind: 0,
			created_at: Math.floor(Date.now() / 1000),
			tags: [],
			content: JSON.stringify({ name })
		},
		generateSecretKey()
	);
}

// Seeded before the first restore: the cache module loads localStorage once.
const staleSilent = metadata('stale-silent');
const staleAnswered = metadata('stale-answered');
const freshPlain = metadata('fresh-plain');
const freshHinted = metadata('fresh-hinted');
local.set(
	STORAGE_KEY,
	JSON.stringify({
		[staleSilent.pubkey]: { event: staleSilent, fetchedAt: Date.now() - 13 * HOUR },
		[staleAnswered.pubkey]: { event: staleAnswered, fetchedAt: Date.now() - 13 * HOUR },
		[freshPlain.pubkey]: { event: freshPlain, fetchedAt: Date.now() },
		[freshHinted.pubkey]: { event: freshHinted, fetchedAt: Date.now() }
	})
);

function persistedStamp(pubkey: string): number | undefined {
	const raw = JSON.parse(local.get(STORAGE_KEY) ?? '{}') as Record<string, { fetchedAt: number }>;
	return raw[pubkey]?.fetchedAt;
}

function queryStatus(pubkey: string): string | undefined {
	return queryClient
		.getQueryCache()
		.getAll()
		.find((query) => JSON.stringify(query.queryKey).includes(pubkey))?.state.status;
}

afterEach(() => {
	vi.useRealTimers();
	queryClient.clear();
	loader.calls.length = 0;
});

describe('ensureProfileLoaded with a persisted profile', () => {
	test('a restored stale copy does not satisfy its own refresh, and a timeout does not restamp it', async () => {
		vi.useFakeTimers();
		const before = persistedStamp(staleSilent.pubkey);

		ensureProfileLoaded(staleSilent.pubkey);
		// The store replays the restored event synchronously; it must not finish the query.
		await vi.advanceTimersByTimeAsync(50);
		expect(loader.calls).toEqual([staleSilent.pubkey]);
		expect(queryStatus(staleSilent.pubkey)).toBe('pending');

		await vi.advanceTimersByTimeAsync(10_000 + 1_000);
		expect(persistedStamp(staleSilent.pubkey)).toBe(before);
	});

	test('a completed relay read restamps the copy so it is not re-asked', async () => {
		vi.useFakeTimers();
		const before = persistedStamp(staleAnswered.pubkey);

		ensureProfileLoaded(staleAnswered.pubkey);
		await vi.advanceTimersByTimeAsync(50);
		loader.complete();
		await vi.advanceTimersByTimeAsync(50);
		expect(queryStatus(staleAnswered.pubkey)).toBe('success');

		await vi.advanceTimersByTimeAsync(1_000);
		expect(persistedStamp(staleAnswered.pubkey)).toBeGreaterThan(before!);
	});

	test('a fresh copy skips the relay read unless the caller supplies hints', async () => {
		ensureProfileLoaded(freshPlain.pubkey);
		await vi.waitFor(() => expect(loader.calls).toEqual([]));

		ensureProfileLoaded(freshHinted.pubkey, ['wss://hint.test']);
		await vi.waitFor(() => expect(loader.calls).toEqual([freshHinted.pubkey]));

		// Settle the hinted read so the cache clear in afterEach has nothing to cancel.
		loader.complete();
		await vi.waitFor(() => expect(queryStatus(freshHinted.pubkey)).toBe('success'));
	});
});
