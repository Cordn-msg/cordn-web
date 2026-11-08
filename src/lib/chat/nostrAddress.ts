import type { AddressPointer } from 'nostr-tools/nip19';

/**
 * Parse a NIP-33 `a` tag (`kind:pubkey:identifier`) into an address pointer.
 * A `wss://`/`ws://` relay hint is attached as the pointer's relay list.
 */
export function parseNostrAddress(
	value: string | undefined,
	relayHint?: string
): AddressPointer | null {
	if (!value) return null;
	const kindEnd = value.indexOf(':');
	if (kindEnd <= 0) return null;
	const pubkeyEnd = value.indexOf(':', kindEnd + 1);
	if (pubkeyEnd <= kindEnd + 1) return null;

	const kind = Number(value.slice(0, kindEnd));
	const pubkey = value.slice(kindEnd + 1, pubkeyEnd);
	const identifier = value.slice(pubkeyEnd + 1);
	if (!Number.isInteger(kind) || kind < 0 || !pubkey || !identifier) return null;

	const relays = relayHint && /^wss?:\/\//i.test(relayHint) ? { relays: [relayHint] } : undefined;
	return { kind, pubkey, identifier, ...relays };
}
