export const DEFAULT_CHAT_COORDINATOR_PUBKEY =
	'92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5';

/**
 * Blossom (BUD-01/02/11) content stores for encrypted media
 * (spec/applications/encrypted-media.md §6). The sender picks one for upload;
 * the chosen server's GET URL is carried in the `imeta`, so receivers just
 * follow it — no per-user sync. User-configurable via the chat config route.
 *
 * Every server here was verified to accept an `application/octet-stream` PUT
 * (the truthful Content-Type for AEAD ciphertext) AND return the exact bytes
 * back on GET. Deliberately excluded: media-optimizer stores that reject
 * octet-stream (nostr.build / blossom.band, 24242.io) or silently re-encode
 * uploads (bostr.online, relay.nostr.net), which would break AEAD decryption
 * for recipients.
 */
export const DEFAULT_BLOSSOM_SERVER = 'https://blossom.primal.net/';
export const BLOSSOM_SERVERS = [
	'https://blossom.primal.net/',
	'https://cdn.hzrd149.com/',
	'https://blossom.ditto.pub/',
	'https://files.sovbit.host/',
	'https://blossom.data.haus/',
	'https://0x0.happytavern.co/',
	'https://blossom.nmail.li/',
	'https://media.libernet.app/',
	'https://blossom.seq1.net/',
	'https://bloom.czas.live/',
	'https://blossom.saynoto.top/',
	'https://relay.gulugulu.moe/',
	'https://blossom-01.uid.ovh/',
	'https://milo.nostria.app/'
] as const;
