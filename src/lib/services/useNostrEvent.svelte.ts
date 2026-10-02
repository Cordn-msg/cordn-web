import { eventStore } from '$lib/services/eventStore';
import { ensureNostrEventLoaded } from '$lib/services/loaders.svelte';
import type { NostrEvent } from 'nostr-tools';
import type { AddressPointer, EventPointer } from 'nostr-tools/nip19';

/**
 * Subscribe to a pasted nostr event pointer (nevent/note/naddr) as reactive
 * state, and load it from relays when missing. Same shape as `useProfile`:
 * bridges the RxJS `eventStore.event()` model to Svelte reactivity with an
 * isolated subscription; the model replays cached values synchronously so an
 * already-seen event renders without a skeleton frame. Must be called during
 * component init; read `current` reactively.
 */
export function useNostrEvent(getPointer: () => EventPointer | AddressPointer): {
	readonly current: NostrEvent | undefined;
} {
	let event = $state<NostrEvent | undefined>(undefined);
	let boundKey = '';
	let sub: { unsubscribe(): void } | undefined;

	const bind = (pointer: EventPointer | AddressPointer) => {
		const key =
			'id' in pointer
				? `id:${pointer.id}`
				: `addr:${pointer.kind}:${pointer.pubkey}:${pointer.identifier}`;
		if (key === boundKey) return;
		sub?.unsubscribe();
		sub = undefined;
		boundKey = key;
		// Reset on pointer change so a stale event never shows for the new target.
		event = undefined;
		ensureNostrEventLoaded(pointer);
		sub = eventStore.event(pointer).subscribe((next) => {
			event = next;
		});
	};

	bind(getPointer());
	$effect(() => {
		bind(getPointer());
		return () => {
			sub?.unsubscribe();
			sub = undefined;
			boundKey = '';
		};
	});

	return {
		get current() {
			return event;
		}
	};
}
