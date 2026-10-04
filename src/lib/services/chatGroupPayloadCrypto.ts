import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes } from '@noble/ciphers/utils.js';
import { base64ToBytes, bytesToBase64, mlsExporter, type ClientState } from 'ts-mls';
import { getCordnCipherSuite } from '$lib/services/chatMlsUtils';

const encoder = new TextEncoder();

/** spec/03 §4 — exporter parameters for the per-epoch content-protection key. */
const GROUP_PAYLOAD_EXPORTER_LABEL = 'cordn';
const GROUP_PAYLOAD_EXPORTER_CONTEXT = 'group-payload';
const GROUP_PAYLOAD_KEY_BYTES = 32;
const GROUP_PAYLOAD_NONCE_BYTES = 12;
const GROUP_PAYLOAD_TAG_BYTES = 16;

const payloadKeyCache = new WeakMap<Uint8Array, Uint8Array>();

async function deriveGroupPayloadKey(state: ClientState): Promise<Uint8Array> {
	// Per-epoch cache keyed on the exporterSecret object reference: every
	// decode of a state creates a fresh secret object, so this is one HKDF per
	// epoch instead of one per message (measured ~0.25ms per derivation).
	// Concurrent first-derives produce the same deterministic key, so the
	// miss-miss-set race is harmless.
	const cached = payloadKeyCache.get(state.keySchedule.exporterSecret);
	if (cached) return cached;
	const cipherSuite = await getCordnCipherSuite();
	const key = await mlsExporter(
		state.keySchedule.exporterSecret,
		GROUP_PAYLOAD_EXPORTER_LABEL,
		encoder.encode(GROUP_PAYLOAD_EXPORTER_CONTEXT),
		GROUP_PAYLOAD_KEY_BYTES,
		cipherSuite
	);
	payloadKeyCache.set(state.keySchedule.exporterSecret, key);
	return key;
}

/** Seal a serialized MLS message (base64) under the current epoch's exporter
 *  secret using ChaCha20-Poly1305 with empty AAD (spec/03 §4-§5). Wire format:
 *  base64(12-byte nonce || ciphertext-with-16-byte tag). */
export async function encryptGroupPayloadBase64(params: {
	state: ClientState;
	opaqueMessageBase64: string;
}): Promise<{ encryptedBase64: string }> {
	const key = await deriveGroupPayloadKey(params.state);
	const nonce = randomBytes(GROUP_PAYLOAD_NONCE_BYTES);
	const ciphertext = chacha20poly1305(key, nonce, new Uint8Array(0)).encrypt(
		base64ToBytes(params.opaqueMessageBase64)
	);
	return { encryptedBase64: bytesToBase64(concatBytes(nonce, ciphertext)) };
}

/** Unseal a spec/03 payload back to the serialized MLS message (base64) for
 *  downstream MLS processing. Throws on payloads shorter than the
 *  nonce+tag minimum or on AEAD verification failure (spec/03 §7). */
export async function decryptGroupPayloadBase64(params: {
	state: ClientState;
	encryptedBase64: string;
}): Promise<{ opaqueMessageBase64: string }> {
	const key = await deriveGroupPayloadKey(params.state);
	return decryptGroupPayloadWithKey(key, params.encryptedBase64);
}

function decryptGroupPayloadWithKey(
	key: Uint8Array,
	encryptedBase64: string
): { opaqueMessageBase64: string } {
	const payload = base64ToBytes(encryptedBase64);
	if (payload.length < GROUP_PAYLOAD_NONCE_BYTES + GROUP_PAYLOAD_TAG_BYTES) {
		throw new Error('Sealed payload too short');
	}
	const nonce = payload.subarray(0, GROUP_PAYLOAD_NONCE_BYTES);
	const ciphertext = payload.subarray(GROUP_PAYLOAD_NONCE_BYTES);
	const serialized = chacha20poly1305(key, nonce, new Uint8Array(0)).decrypt(ciphertext);
	return { opaqueMessageBase64: bytesToBase64(serialized) };
}

/** The per-epoch payload key of a state, for retention on the group record.
 *  A sender that has not seen our latest Commit seals under an epoch we already
 *  left (the report-05 "disappearing messages" class): ts-mls keeps 4 epochs of
 *  receiver material INSIDE, and this is the outer seal's share of that. */
export async function deriveGroupPayloadKeyBase64(state: ClientState): Promise<string> {
	return bytesToBase64(await deriveGroupPayloadKey(state));
}

/** Unseal with a retained former-epoch key. Null on verification failure. */
export function decryptGroupPayloadWithKeyBase64(
	keyBase64: string,
	encryptedBase64: string
): string | null {
	try {
		return decryptGroupPayloadWithKey(base64ToBytes(keyBase64), encryptedBase64)
			.opaqueMessageBase64;
	} catch {
		return null;
	}
}
