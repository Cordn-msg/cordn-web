import { createAddressLoader, createEventLoader } from 'applesauce-loaders/loaders';
import type { AddressPointer, EventPointer } from 'nostr-tools/nip19';
import { metadataRelays, relayPool, commonRelays } from './relay-pool';
import { eventStore } from './eventStore';
import { getOutboxes } from 'applesauce-core/helpers';
import { kinds } from 'nostr-tools';
import { SvelteSet } from 'svelte/reactivity';
// Create address loader
export const addressLoader = createAddressLoader(relayPool, { eventStore });

// Loads events by id (nevent/note embeds): pointer relay hints first, then a
// small set of well-known read relays. Batches + dedupes through eventStore.
export const eventByIdLoader = createEventLoader(relayPool, {
	eventStore,
	extraRelays: commonRelays
});

const pointerKey = (pointer: EventPointer | AddressPointer) =>
	'id' in pointer ? pointer.id : `${pointer.kind}:${pointer.pubkey}:${pointer.identifier}`;

const inFlightNostrEvents = new Set<string>();

/** Fetch a pasted nevent/naddr/note into the event store once (embed cards
 *  subscribe via eventStore.event(), this only fills the store). In-flight
 *  set guards remounts — the virtualizer remounts rows freely. */
export function ensureNostrEventLoaded(pointer: EventPointer | AddressPointer): void {
	const key = pointerKey(pointer);
	if (inFlightNostrEvents.has(key)) return;
	if (
		'id' in pointer
			? eventStore.hasEvent(pointer.id)
			: eventStore.hasReplaceable(pointer.kind, pointer.pubkey, pointer.identifier)
	)
		return;

	inFlightNostrEvents.add(key);
	const done = () => inFlightNostrEvents.delete(key);
	const load =
		'id' in pointer
			? eventByIdLoader(pointer).subscribe({ error: done, complete: done })
			: addressLoader({
					kind: pointer.kind,
					pubkey: pointer.pubkey,
					identifier: pointer.identifier,
					relays: pointer.relays?.length ? pointer.relays : metadataRelays
				}).subscribe({ error: done, complete: done });
	// Address/event loaders complete on their own (finite requests); the
	// in-flight flag clears on completion, a store hit makes re-ensure a no-op.
	void load;
}

export const createUserRelayListByPubkeyLoader = (pubkey: string, relays?: string[]) => {
	const selectedRelays = relays || metadataRelays;
	return addressLoader({
		pubkey,
		kind: kinds.RelayList,
		relays: selectedRelays
	});
};

export const getUserRelayListFromStore = (pubkey: string): string[] => {
	const relayList = eventStore.getReplaceable(kinds.RelayList, pubkey);
	if (!relayList) return [];
	const uniqueRelays = new SvelteSet(
		getOutboxes(relayList)
			.map((relay) => relay.trim())
			.filter(Boolean)
	);

	return [...uniqueRelays];
};
