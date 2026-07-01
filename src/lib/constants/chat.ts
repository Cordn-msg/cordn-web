export const DEFAULT_CHAT_COORDINATOR_PUBKEY =
	'92753cbe63e943d0c4a0c61d745437892af6e98f179ce04a7a863aad4e00b1a5';

/**
 * Blossom (BUD-01/02/11) content stores for encrypted media
 * (spec/applications/encrypted-media.md §6). The sender picks one for upload;
 * the chosen server's GET URL is carried in the `imeta`, so receivers just
 * follow it — no per-user sync. User-configurable via the chat config route.
 */
export const DEFAULT_BLOSSOM_SERVER = 'https://blossom.primal.net/';
export const BLOSSOM_SERVERS = [
	'https://blossom.primal.net/',
	'https://24242.io/',
	'https://blossom.band/',
	'https://nostr.download/'
] as const;
