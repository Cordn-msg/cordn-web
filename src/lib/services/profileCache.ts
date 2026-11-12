import { browser } from '$app/environment';
import { Metadata } from 'nostr-tools/kinds';
import type { NostrEvent } from 'nostr-tools';
import { eventStore } from '$lib/services/eventStore';
import { safeNormalizePubKey } from '$lib/utils';

/**
 * Persisted kind-0 profiles, so the first render after a restart shows names
 * instead of refetching every visible author from the metadata relays.
 *
 * Display-only cache: it restores events into the same `eventStore` the loaders
 * publish into, so nothing downstream knows it exists and replaceable-event
 * rules stay in the store. Events are stored raw, so a restore still runs the
 * store's signature check.
 *
 * shortcut: a kind-5 deletion of a cached profile is not persisted, so a
 * restart can show the deleted profile for up to FRESH_MS; cache delete events
 * too if profile deletion ever matters.
 */
const STORAGE_KEY = 'cordn.profile-cache';
/** Show a persisted profile for this long without asking a relay. */
const FRESH_MS = 12 * 60 * 60 * 1000;
/** Nothing older is kept; a miss costs one relay read. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Bound on stored profiles — the visible social graph, not the whole network. */
const MAX_ENTRIES = 400;
/** One write per burst of inserts instead of one per profile. */
const SAVE_DEBOUNCE_MS = 1000;
/** Skip oversized metadata (a long `about` fits; a data: URI does not). */
const MAX_EVENT_BYTES = 8 * 1024;

type CachedProfile = { event: NostrEvent; fetchedAt: number };

let cache: Record<string, CachedProfile> = {};
let initialized = false;
/** `eventStore.add` emits synchronously; a restore must not read as a fresh fetch. */
let restoring = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function isCachedProfile(value: unknown): value is CachedProfile {
	const entry = value as CachedProfile | null;
	const event = entry?.event;
	return Boolean(
		entry &&
		Number.isFinite(entry.fetchedAt) &&
		event &&
		event.kind === Metadata &&
		typeof event.id === 'string' &&
		typeof event.pubkey === 'string' &&
		typeof event.sig === 'string' &&
		typeof event.content === 'string' &&
		Number.isFinite(event.created_at) &&
		Array.isArray(event.tags)
	);
}

function load(): void {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const now = Date.now();
		for (const [pubkey, value] of Object.entries(parsed)) {
			if (!isCachedProfile(value)) continue;
			if (now - value.fetchedAt > RETENTION_MS) continue;
			// Key and payload must agree, or the entry can never be found again.
			if (safeNormalizePubKey(value.event.pubkey) !== pubkey) continue;
			cache[pubkey] = value;
		}
	} catch {
		cache = {};
	}
}

function prune(): void {
	const now = Date.now();
	cache = Object.fromEntries(
		Object.entries(cache)
			.filter(([, entry]) => now - entry.fetchedAt <= RETENTION_MS)
			.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
			.slice(0, MAX_ENTRIES)
	);
}

function flush(): void {
	saveTimer = undefined;
	prune();
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
	} catch {
		// Quota or a disabled store: this cache is an optimization, never state.
	}
}

function scheduleSave(): void {
	if (!browser || saveTimer !== undefined) return;
	saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

function remember(event: NostrEvent): void {
	if (restoring) return;
	const key = safeNormalizePubKey(event.pubkey);
	if (!key) return;
	if (JSON.stringify(event).length > MAX_EVENT_BYTES) return;
	cache[key] = { event, fetchedAt: Date.now() };
	scheduleSave();
}

function init(): void {
	if (initialized || !browser) return;
	initialized = true;
	load();
	// Every profile that reaches the store came from a relay (or from us).
	eventStore.insert$.subscribe((event) => {
		if (event.kind === Metadata) remember(event);
	});
}

/**
 * Put the persisted profile for `pubkey` back in the event store.
 * Returns true when it is fresh enough that a relay read would be discarded.
 */
export function restoreCachedProfile(pubkey: string): boolean {
	const key = safeNormalizePubKey(pubkey);
	if (!browser || !key) return false;
	init();
	const entry = cache[key];
	if (!entry) return false;
	if (!eventStore.hasReplaceable(Metadata, key)) {
		restoring = true;
		try {
			if (!eventStore.add(entry.event)) {
				// Rejected by the store (bad signature): never keep it.
				delete cache[key];
				scheduleSave();
				return false;
			}
		} finally {
			restoring = false;
		}
	}
	return Date.now() - entry.fetchedAt < FRESH_MS;
}

/**
 * A relay was just asked for this profile: keep showing the cached copy without
 * asking again inside the fresh window, even when the answer was unchanged
 * (an identical event emits no insert, so `remember` cannot bump the stamp).
 */
export function markProfileChecked(pubkey: string): void {
	const key = safeNormalizePubKey(pubkey);
	const entry = cache[key];
	if (!entry) return;
	entry.fetchedAt = Date.now();
	scheduleSave();
}

/** "Log out and clean data": the cached social graph goes with the account. */
export function clearProfileCache(): void {
	cache = {};
	if (saveTimer !== undefined) {
		clearTimeout(saveTimer);
		saveTimer = undefined;
	}
	if (!browser) return;
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Ignore: nothing durable to clear.
	}
}
