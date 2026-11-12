import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools';

vi.mock('$app/environment', () => ({ browser: true }));

/** Minimal event store: replaceable slot per kind+pubkey plus the insert stream. */
const stored = new Map<string, NostrEvent>();
const insertListeners: ((event: NostrEvent) => void)[] = [];
vi.mock('$lib/services/eventStore', () => ({
	eventStore: {
		hasReplaceable: (kind: number, pubkey: string) => stored.has(`${kind}:${pubkey}`),
		// Mirrors the store's signature gate: a rejected event never lands.
		add: (event: NostrEvent) => {
			if (!event.sig) return null;
			stored.set(`${event.kind}:${event.pubkey}`, event);
			for (const listener of insertListeners) listener(event);
			return event;
		},
		insert$: {
			subscribe: (listener: (event: NostrEvent) => void) => {
				insertListeners.push(listener);
				return { unsubscribe: () => {} };
			}
		}
	}
}));

const LOCAL_STORAGE_KEY = 'cordn.profile-cache';
const local = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (key: string) => local.get(key) ?? null,
	setItem: (key: string, value: string) => local.set(key, value),
	removeItem: (key: string) => local.delete(key)
});

const NOW = new Date('2026-06-01T12:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;

function pubkey(last: string): string {
	return last.repeat(64);
}

function metadata(
	from: string,
	{ createdAt = 1000, content = '{"name":"cached"}' } = {}
): NostrEvent {
	return {
		id: (from.slice(0, 1) === 'a' ? 'b' : 'c').repeat(64),
		pubkey: from,
		created_at: createdAt,
		kind: 0,
		tags: [],
		content,
		sig: 'e'.repeat(128)
	};
}

function seed(entries: Record<string, { event: NostrEvent; fetchedAt: number }>): void {
	local.set(LOCAL_STORAGE_KEY, JSON.stringify(entries));
}

function persisted(): Record<string, { event: NostrEvent; fetchedAt: number }> {
	return JSON.parse(local.get(LOCAL_STORAGE_KEY) ?? '{}');
}

async function loadModule() {
	vi.resetModules();
	return import('./profileCache');
}

describe('profileCache', () => {
	// Pay the module-graph transform once (it imports $lib/utils), not inside a
	// 5s test budget on a loaded suite.
	beforeAll(async () => {
		await import('./profileCache');
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		stored.clear();
		insertListeners.length = 0;
		local.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('a fresh cached profile is restored into the store without a relay read', async () => {
		const key = pubkey('a');
		seed({ [key]: { event: metadata(key), fetchedAt: NOW - HOUR } });
		const cache = await loadModule();

		expect(cache.restoreCachedProfile(key)).toBe(true);
		expect(stored.get(`0:${key}`)?.content).toBe('{"name":"cached"}');
		// Restoring is not a fresh fetch: the stamp must not roll forward.
		vi.advanceTimersByTime(2000);
		expect(persisted()[key].fetchedAt).toBe(NOW - HOUR);
	});

	test('a stale profile still renders, but asks for a relay read', async () => {
		const key = pubkey('b');
		seed({ [key]: { event: metadata(key), fetchedAt: NOW - 24 * HOUR } });
		const cache = await loadModule();

		expect(cache.restoreCachedProfile(key)).toBe(false);
		expect(stored.has(`0:${key}`)).toBe(true);
	});

	test('garbage and unverifiable entries are dropped instead of restored', async () => {
		const unsigned = pubkey('c');
		seed({
			// Key and payload disagree: it could never be found again.
			[pubkey('f')]: { event: metadata(pubkey('e')), fetchedAt: NOW },
			[pubkey('d')]: { event: { ...metadata(pubkey('d')), kind: 9 }, fetchedAt: NOW },
			[unsigned]: { event: { ...metadata(unsigned), sig: '' }, fetchedAt: NOW },
			[pubkey('1')]: 'nope' as never,
			[pubkey('2')]: { event: metadata(pubkey('2')), fetchedAt: 'soon' as never }
		});
		const cache = await loadModule();

		expect(cache.restoreCachedProfile(pubkey('f'))).toBe(false);
		expect(cache.restoreCachedProfile(pubkey('d'))).toBe(false);
		expect(cache.restoreCachedProfile(pubkey('1'))).toBe(false);
		expect(cache.restoreCachedProfile(pubkey('2'))).toBe(false);
		// The store rejects the bad signature, so it must not count as fresh.
		expect(cache.restoreCachedProfile(unsigned)).toBe(false);
		expect(stored.size).toBe(0);
		// The next write rebuilds the cache from memory, dropping all of them.
		insertListeners.forEach((listener) => listener(metadata(pubkey('a'))));
		vi.advanceTimersByTime(2000);
		expect(Object.keys(persisted())).toEqual([pubkey('a')]);
	});

	test('new kind-0 events are recorded; other kinds are not', async () => {
		const cache = await loadModule();
		cache.restoreCachedProfile(pubkey('a')); // initializes the store listener
		const profile = pubkey('a');
		const contact = pubkey('b');

		insertListeners.forEach((listener) =>
			listener(metadata(profile, { content: '{"name":"new"}' }))
		);
		insertListeners.forEach((listener) => listener({ ...metadata(contact), kind: 3 }));
		vi.advanceTimersByTime(2000);

		expect(persisted()[profile].event.content).toBe('{"name":"new"}');
		expect(persisted()[contact]).toBeUndefined();
	});

	test('markProfileChecked refreshes the stamp so an identical answer is not re-asked', async () => {
		const key = pubkey('a');
		seed({ [key]: { event: metadata(key), fetchedAt: NOW - 24 * HOUR } });
		const cache = await loadModule();

		cache.restoreCachedProfile(key);
		cache.markProfileChecked(key);
		vi.advanceTimersByTime(2000);

		expect(persisted()[key].fetchedAt).toBe(NOW);
		expect(cache.restoreCachedProfile(key)).toBe(true);
	});

	test('clean data clears the cache; later inserts are still recorded', async () => {
		const key = pubkey('a');
		seed({ [key]: { event: metadata(key), fetchedAt: NOW } });
		const cache = await loadModule();
		cache.restoreCachedProfile(key);
		insertListeners.forEach((listener) => listener(metadata(pubkey('b'))));

		cache.clearProfileCache();
		expect(local.has(LOCAL_STORAGE_KEY)).toBe(false);
		expect(cache.restoreCachedProfile(key)).toBe(false);

		insertListeners.forEach((listener) => listener(metadata(pubkey('c'))));
		vi.advanceTimersByTime(2000);
		expect(persisted()[pubkey('c')]).toBeDefined();
		expect(persisted()[key]).toBeUndefined();
	});

	test('the stored set is bounded, oldest entries dropped first', async () => {
		const cache = await loadModule();
		cache.restoreCachedProfile(pubkey('a'));
		// 401 distinct authors, fetched one ms apart so the order is total.
		for (let index = 0; index <= 400; index += 1) {
			const key = index.toString(16).padStart(64, '0');
			vi.setSystemTime(NOW + index);
			insertListeners.forEach((listener) => listener(metadata(key)));
		}
		vi.advanceTimersByTime(2000);

		const entries = Object.keys(persisted());
		expect(entries).toHaveLength(400);
		expect(entries).not.toContain('0'.repeat(64));
		expect(entries).toContain((400).toString(16).padStart(64, '0'));
	});
});
