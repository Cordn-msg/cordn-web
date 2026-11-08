import { firstValueFrom } from 'applesauce-core/observable';

import {
	EMOJI_SET_KIND,
	parseEmojiSetEvent,
	type EmojiPack,
	type EmojiPackAddress
} from '$lib/chat/emoji';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { eventStore } from '$lib/services/eventStore';
import { addressLoader } from '$lib/services/loaders.svelte';
import { metadataRelays } from '$lib/services/relay-pool';

const FETCH_TIMEOUT_MS = 8000;

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
			const relays = [
				...new Set([...address.relays, ...metadataRelays].map((relay) => relay.trim()))
			].filter((relay) => relay.startsWith('wss://') || relay.startsWith('ws://'));
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const event = await Promise.race([
					firstValueFrom(
						addressLoader({
							kind: EMOJI_SET_KIND,
							pubkey: address.pubkey,
							identifier: address.identifier,
							relays
						})
					),
					new Promise<null>((resolve) => {
						timer = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
					})
				]);
				return event ? parseEmojiSetEvent(event) : null;
			} catch {
				return null;
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
		staleTime: 5 * 60 * 1000
	};
}
