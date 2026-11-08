import { browser } from '$app/environment';
import type { NostrEvent } from 'nostr-tools';
import {
	EMOJI_SET_KIND,
	emojiPacksFromEvents,
	isEmojiRelayUrl,
	type EmojiPack
} from '$lib/chat/emoji';
import { commonRelays, metadataRelays, relayPool } from '$lib/services/relay-pool';

const STORAGE_KEY = 'cordn.emojiDiscoveryRelays';
const REQUEST_TIMEOUT_MS = 8_000;

/** The app's existing common/metadata sets; no new relay list to maintain. */
export const EMOJI_DISCOVERY_RELAY_OPTIONS = [...new Set([...commonRelays, ...metadataRelays])];

function normalizeRelays(relays: unknown[]): string[] {
	return [
		...new Set(
			relays.filter((relay): relay is string => typeof relay === 'string' && isEmojiRelayUrl(relay))
		)
	];
}

/** Selected discovery relays, or the app defaults when the user never chose. */
export function getEmojiDiscoveryRelays(): string[] {
	if (!browser) return [...EMOJI_DISCOVERY_RELAY_OPTIONS];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return [...EMOJI_DISCOVERY_RELAY_OPTIONS];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? normalizeRelays(parsed) : [...EMOJI_DISCOVERY_RELAY_OPTIONS];
	} catch {
		return [...EMOJI_DISCOVERY_RELAY_OPTIONS];
	}
}

export function setEmojiDiscoveryRelays(relays: unknown[]): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeRelays(relays)));
	} catch {
		// Storage blocked: the in-page selection still works for this visit.
	}
}

/** Ask the selected relays for recent kind-30030 sets. One relay's failure is just an empty answer. */
export async function searchEmojiPacks(relays: string[]): Promise<EmojiPack[]> {
	const selected = normalizeRelays(relays);
	if (selected.length === 0) return [];

	const events = new Map<string, NostrEvent>();
	await new Promise<void>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let subscription: { unsubscribe: () => void } | null = null;

		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve();
		};

		subscription = relayPool
			.request(
				selected,
				{ kinds: [EMOJI_SET_KIND], limit: 100 },
				{ reconnect: 1, timeout: REQUEST_TIMEOUT_MS }
			)
			.subscribe({
				next: (event) => events.set(event.id, event),
				complete: finish,
				error: finish
			});

		if (!settled) {
			timer = setTimeout(() => {
				try {
					subscription?.unsubscribe();
				} catch {
					// Best effort: a relay that never answers must not hold the search open.
				}
				finish();
			}, REQUEST_TIMEOUT_MS + 500);
		}
	});

	return emojiPacksFromEvents(events.values()).map((pack) => ({ ...pack, relays: selected }));
}
