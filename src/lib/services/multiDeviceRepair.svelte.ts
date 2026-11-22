import type { NostrEvent } from 'nostr-tools';
import { relayPool } from '$lib/services/relay-pool';
import { fetchBlob, uploadBlob } from '$lib/services/chatBlossomClient';
import { documentAddress, isNewerTipEvent, type TipPointer } from '$lib/services/multiDevice';
import {
	ephemeralSigner,
	readMultiDeviceTipEvent,
	type MultiDeviceOwnerConfig
} from '$lib/services/multiDevice.svelte';
import {
	probeBlossomTip,
	probeRelayTips,
	type BlobProbe,
	type RelayTipProbe
} from '$lib/services/multiDeviceDev.svelte';

export interface MultiDeviceHealth {
	checkedAt: number;
	relays: RelayTipProbe[];
	blobs: BlobProbe[];
	missing: BlobProbe[];
	lost: string[];
	servers: string[];
	tipEvent: NostrEvent | null;
}

export function planDocumentRepairs(blobs: BlobProbe[]): {
	missing: BlobProbe[];
	lost: string[];
} {
	const addresses = [...new Set(blobs.map((row) => row.address))];
	// Only a definitive 404 is a copy we can fill. An unreachable or gated host
	// (status 0/401/403) is unknown, not absent — uploading there would be a guess.
	const missing = blobs.filter(
		(row) =>
			row.status === 404 && blobs.some((other) => other.address === row.address && other.present)
	);
	// "Lost" means every host that answered said 404. If any host was unreachable,
	// the bytes may still exist there and we must not claim the document is gone.
	const lost = addresses.filter((address) =>
		blobs.filter((row) => row.address === address).every((row) => row.status === 404)
	);
	return { missing, lost };
}

/** Read-only inventory check against the newest verified tip any relay serves. */
export async function checkMultiDeviceHealth(
	config: MultiDeviceOwnerConfig
): Promise<MultiDeviceHealth> {
	const relays = await probeRelayTips(config);
	const tipEvent = relays.reduce<NostrEvent | null>((newest, row) => {
		const candidate = row.event;
		return candidate && (!newest || isNewerTipEvent(candidate, newest)) ? candidate : newest;
	}, null);
	const pointer: TipPointer | null = tipEvent
		? await readMultiDeviceTipEvent(tipEvent, config.ownerPubkey)
		: null;
	if (tipEvent && !pointer) throw new Error('The newest multi-device tip could not be opened');
	const servers = [
		...new Set(
			[...(pointer?.servers ?? []), ...config.blossomServers].map((s) => s.replace(/\/+$/, ''))
		)
	];
	const blobs = pointer ? await probeBlossomTip(pointer, servers) : [];
	return {
		checkedAt: Date.now(),
		relays,
		blobs,
		...planDocumentRepairs(blobs),
		servers,
		tipEvent
	};
}

/** Mirror existing signed/sealed bytes only; never create a new tip or MLS state. */
export async function repairMultiDeviceHealth(config: MultiDeviceOwnerConfig): Promise<{
	summary: string;
	health: MultiDeviceHealth;
}> {
	const before = await checkMultiDeviceHealth(config);
	let relaysCopied = 0;
	let documentsCopied = 0;
	const failures: string[] = [];
	const weakRelays = before.relays.filter((row) => row.eventId !== before.tipEvent?.id);
	const tipEvent = before.tipEvent;
	if (tipEvent) {
		const results = await Promise.allSettled(
			weakRelays.map(async (row) => {
				const accepted = await relayPool.publish([row.relay], tipEvent, { timeout: 5000 });
				if (!accepted.some((response) => response.ok)) {
					const reason = accepted.find((response) => response.message)?.message;
					throw new Error(`tip refused${reason ? ` (${reason})` : ''}`);
				}
				return row.relay;
			})
		);
		results.forEach((result, index) => {
			if (result.status === 'fulfilled') relaysCopied++;
			else
				failures.push(
					`${weakRelays[index].relay}: ${result.reason instanceof Error ? result.reason.message : 'tip failed'}`
				);
		});
	}

	const byAddress = new Map<string, BlobProbe[]>();
	for (const row of before.missing) {
		const rows = byAddress.get(row.address) ?? [];
		rows.push(row);
		byAddress.set(row.address, rows);
	}
	for (const [address, targets] of byAddress) {
		const sources = before.blobs.filter((row) => row.address === address && row.present);
		let sealed: Uint8Array | undefined;
		for (const source of sources) {
			try {
				const candidate = await fetchBlob(
					`${source.server.replace(/\/+$/, '')}/${address}`,
					AbortSignal.timeout(20_000)
				);
				if (documentAddress(new TextDecoder().decode(candidate)) !== address) {
					throw new Error('content hash mismatch');
				}
				sealed = candidate;
				break;
			} catch {
				// Another healthy replica may still have the right bytes.
			}
		}
		if (!sealed) {
			failures.push(`${address.slice(0, 8)}…: no readable source copy`);
			continue;
		}
		const results = await Promise.allSettled(
			targets.map(async (target) => {
				const uploaded = await uploadBlob({
					serverUrl: target.server,
					blob: sealed,
					// The persisted multi-device key, so normal cleanup can still delete the copy.
					signer: ephemeralSigner(config),
					signal: AbortSignal.timeout(30_000)
				});
				if (uploaded.sha256.toLowerCase() !== address) {
					throw new Error('host returned a foreign content hash');
				}
				return uploaded;
			})
		);
		documentsCopied += results.filter((result) => result.status === 'fulfilled').length;
		results.forEach((result, index) => {
			if (result.status === 'rejected') failures.push(`${targets[index].server}: upload failed`);
		});
	}

	const health = await checkMultiDeviceHealth(config);
	const repaired = relaysCopied + documentsCopied;
	const parts: string[] = [];
	if (repaired > 0) parts.push(`Restored ${repaired} missing cop${repaired === 1 ? 'y' : 'ies'}`);
	if (before.lost.length > 0)
		parts.push(`${before.lost.length} document(s) had no available source copy`);
	if (before.tipEvent === null) parts.push('No tip was available to re-broadcast');
	if (parts.length === 0) parts.push('Nothing to repair');
	if (failures.length > 0) parts.push(`${failures.length} operation(s) failed`);
	return { summary: parts.join('; '), health };
}
