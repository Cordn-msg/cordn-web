import { firstValueFrom } from 'applesauce-core/observable';
import type { NostrEvent } from 'nostr-tools';

import {
	EMOJI_LIST_KIND,
	EMOJI_SET_KIND,
	isEmojiRelayUrl,
	parseEmojiListEvent,
	parseEmojiSetEvent,
	type EmojiPack,
	type EmojiPackAddress
} from '$lib/chat/emoji';
import { ensureUserRelayListLoaded } from '$lib/queries/chatProfileQueries';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { eventStore } from '$lib/services/eventStore';
import { addressLoader, getUserRelayListFromStore } from '$lib/services/loaders.svelte';
import { metadataRelays } from '$lib/services/relay-pool';
import { normalizePubKey } from '$lib/utils';

const FETCH_TIMEOUT_MS = 8000;
const STALE_TIME = 5 * 60 * 1000;

function relaysFor(hints: readonly string[]): string[] {
	return [...new Set([...hints, ...metadataRelays].map((relay) => relay.trim()))].filter(
		isEmojiRelayUrl
	);
}

/** One replaceable event by address. A relay timeout and a missing event are
 *  the same answer to the person looking at it. */
async function loadReplaceable(
	kind: number,
	pubkey: string,
	relays: string[],
	identifier?: string
): Promise<NostrEvent | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const event = await Promise.race([
			firstValueFrom(addressLoader({ kind, pubkey, identifier, relays })),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
			})
		]);
		return event ?? null;
	} catch {
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * A NIP-30 emoji set by address. The event is a public replaceable record, so
 * the same query serves every account; the store is checked first because the
 * loader filters events it already holds.
 */
export function emojiSetQueryOptions(address: EmojiPackAddress) {
	return {
		queryKey: chatQueryKeys.emojiSet(address.pubkey, address.identifier),
		queryFn: async (): Promise<EmojiPack | null> => {
			const held = eventStore.getReplaceable(EMOJI_SET_KIND, address.pubkey, address.identifier);
			if (held) {
				const pack = parseEmojiSetEvent(held);
				if (pack) return pack;
			}
			const event = await loadReplaceable(
				EMOJI_SET_KIND,
				address.pubkey,
				relaysFor(address.relays),
				address.identifier
			);
			return event ? parseEmojiSetEvent(event) : null;
		},
		staleTime: STALE_TIME
	};
}

/**
 * A person's public NIP-51 emoji list: the kind 30030 sets they publish. An
 * empty list and a list we could not find are one answer — there is nothing
 * to show either way.
 */
export function emojiListQueryOptions(pubkey: string) {
	const normalized = normalizePubKey(pubkey);
	return {
		queryKey: chatQueryKeys.emojiList(normalized),
		queryFn: async (): Promise<EmojiPackAddress[]> => {
			const held = eventStore.getReplaceable(EMOJI_LIST_KIND, normalized);
			// A list may live only on this account's own outboxes, so load its NIP-65
			// relays before picking where to ask; held events skip that wait.
			const event =
				held ?? (await loadReplaceable(EMOJI_LIST_KIND, normalized, await listRelays(normalized)));
			return event ? parseEmojiListEvent(event) : [];
		},
		staleTime: STALE_TIME
	};
}

/** Where a list may be published: its author's outboxes plus the metadata relays. */
async function listRelays(pubkey: string): Promise<string[]> {
	await ensureUserRelayListLoaded(pubkey);
	return relaysFor(getUserRelayListFromStore(pubkey));
}
