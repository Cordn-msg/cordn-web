import { describe, expect, test } from 'vitest';
import { bytesToBase64 } from 'ts-mls';
import {
	decryptGroupPayloadBase64,
	encryptGroupPayloadBase64
} from '$lib/services/chatGroupPayloadCrypto';
import type { ClientState } from 'ts-mls';

/**
 * spec/03 sealed-payload round-trip self-check. Runs against the REAL
 * noble ChaCha20-Poly1305 + the real ts-mls exporter derivation (no mocks),
 * so it exercises the actual wrapping logic: nonce concat/split, base64
 * framing, the 28-byte minimum, and AEAD integrity.
 */
function fakeState(exporterSecret: Uint8Array): ClientState {
	// The payload crypto only touches keySchedule.exporterSecret; the rest of
	// the ClientState shape is irrelevant to the seal/unseal path.
	return { keySchedule: { exporterSecret } } as unknown as ClientState;
}

const PAYLOAD = bytesToBase64(new Uint8Array(Array.from({ length: 64 }, (_, i) => i * 7 + 3)));

describe('spec/03 sealed group payload', () => {
	test('round-trips a payload sealed under the same exporter secret', async () => {
		const state = fakeState(new Uint8Array(32).fill(42));
		const { encryptedBase64 } = await encryptGroupPayloadBase64({
			state,
			opaqueMessageBase64: PAYLOAD
		});

		// Sealed form must differ from the plaintext and be base64-decodable.
		expect(encryptedBase64).not.toEqual(PAYLOAD);

		const { opaqueMessageBase64 } = await decryptGroupPayloadBase64({
			state,
			encryptedBase64
		});
		expect(opaqueMessageBase64).toEqual(PAYLOAD);
	});

	test('sealing is non-deterministic (fresh random nonce per call)', async () => {
		const state = fakeState(new Uint8Array(32).fill(7));
		const a = await encryptGroupPayloadBase64({ state, opaqueMessageBase64: PAYLOAD });
		const b = await encryptGroupPayloadBase64({ state, opaqueMessageBase64: PAYLOAD });
		expect(a.encryptedBase64).not.toEqual(b.encryptedBase64);
		// ...but both still decrypt back to the same plaintext.
		expect(
			(await decryptGroupPayloadBase64({ state, encryptedBase64: a.encryptedBase64 }))
				.opaqueMessageBase64
		).toEqual(PAYLOAD);
	});

	test('rejects a payload sealed under a different exporter secret', async () => {
		const sender = fakeState(new Uint8Array(32).fill(1));
		const other = fakeState(new Uint8Array(32).fill(2));
		const { encryptedBase64 } = await encryptGroupPayloadBase64({
			state: sender,
			opaqueMessageBase64: PAYLOAD
		});
		await expect(decryptGroupPayloadBase64({ state: other, encryptedBase64 })).rejects.toThrow();
	});

	test('rejects a tampered ciphertext (AEAD auth tag mismatch)', async () => {
		const state = fakeState(new Uint8Array(32).fill(99));
		const { encryptedBase64 } = await encryptGroupPayloadBase64({
			state,
			opaqueMessageBase64: PAYLOAD
		});
		// Flip a byte in the middle of the ciphertext (past the 12-byte nonce).
		const tampered =
			encryptedBase64.slice(0, 24) +
			(encryptedBase64[24] === 'A' ? 'B' : 'A') +
			encryptedBase64.slice(25);
		await expect(decryptGroupPayloadBase64({ state, encryptedBase64: tampered })).rejects.toThrow();
	});

	test('rejects payloads shorter than the 28-byte nonce+tag minimum', async () => {
		const state = fakeState(new Uint8Array(32).fill(5));
		await expect(
			decryptGroupPayloadBase64({ state, encryptedBase64: bytesToBase64(new Uint8Array(20)) })
		).rejects.toThrow('too short');
	});
});
