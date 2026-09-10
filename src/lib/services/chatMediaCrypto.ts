import { mlsExporter, type ClientState } from 'ts-mls';

import { getCordnCipherSuite } from '$lib/services/chatMlsUtils';

// Re-export the pure cipher layer so main-thread callers keep importing from a
// single module (`chatMediaCrypto`). The dedicated media worker does NOT import
// from here — it imports `decryptMedia` directly from `chatMediaCipher` so the
// MLS state / relay pool never cross the worker boundary.
export * from './chatMediaCipher';

/**
 * spec/03-style exporter derivation with the `"encrypted-media"` context.
 * Main-thread only: it touches the MLS group state (ts-mls). Mirrors
 * `deriveGroupPayloadKey` in chatGroupMessages.svelte.ts exactly, modulo the
 * context string — the two layers MUST stay domain-separated.
 */
const EXPORTER_LABEL = 'cordn';
const EXPORTER_CONTEXT = 'encrypted-media';
const EXPORTER_LENGTH = 32;

const encoder = new TextEncoder();

const mediaKeyCache = new WeakMap<Uint8Array, Uint8Array>();

export async function deriveMediaKey(state: ClientState): Promise<Uint8Array> {
	// Per-epoch cache keyed on the exporterSecret object reference — same
	// rationale as the payload key in chatGroupPayloadCrypto: one HKDF per
	// epoch instead of one per media-bearing message.
	const cached = mediaKeyCache.get(state.keySchedule.exporterSecret);
	if (cached) return cached;
	const cipherSuite = await getCordnCipherSuite();
	const key = await mlsExporter(
		state.keySchedule.exporterSecret,
		EXPORTER_LABEL,
		encoder.encode(EXPORTER_CONTEXT),
		EXPORTER_LENGTH,
		cipherSuite
	);
	mediaKeyCache.set(state.keySchedule.exporterSecret, key);
	return key;
}
