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

async function deriveGroupPayloadKey(state: ClientState): Promise<Uint8Array> {
	const cipherSuite = await getCordnCipherSuite();
	return mlsExporter(
		state.keySchedule.exporterSecret,
		GROUP_PAYLOAD_EXPORTER_LABEL,
		encoder.encode(GROUP_PAYLOAD_EXPORTER_CONTEXT),
		GROUP_PAYLOAD_KEY_BYTES,
		cipherSuite
	);
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
	const payload = base64ToBytes(params.encryptedBase64);
	if (payload.length < GROUP_PAYLOAD_NONCE_BYTES + GROUP_PAYLOAD_TAG_BYTES) {
		throw new Error('Sealed payload too short');
	}
	const key = await deriveGroupPayloadKey(params.state);
	const nonce = payload.subarray(0, GROUP_PAYLOAD_NONCE_BYTES);
	const ciphertext = payload.subarray(GROUP_PAYLOAD_NONCE_BYTES);
	const serialized = chacha20poly1305(key, nonce, new Uint8Array(0)).decrypt(ciphertext);
	return { opaqueMessageBase64: bytesToBase64(serialized) };
}
