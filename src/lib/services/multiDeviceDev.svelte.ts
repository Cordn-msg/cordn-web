/**
 * Multi-device dev-mode probes. Read-only, on-demand diagnostics triggered by
 * the dev panel's "Check now" buttons — never auto-run, never mutate state.
 *
 * Relay coherence: per-relay fan-out of the tip REQ (mirrors `fetchLatestTipEvent`
 *   but scoped to ONE relay so we keep the source attribution the collapsed
 *   fetch deliberately throws away). Coherent = every relay returned the same
 *   event id (no version drift).
 * Blob coherence: BUD-01 `HEAD /<sha256>` per (address × server). No body
 *   download — status + Content-Length only. Coherent = every configured server
 *   has every advertised address.
 *
 * ponytail: `.svelte.ts` only to sit next to `multiDevice.svelte.ts`; the module
 * itself uses no runes — the component holds the reactive state.
 */
import type { NostrEvent } from 'nostr-tools';
import { relayPool } from '$lib/services/relay-pool';
import { hasBlob } from '$lib/services/chatBlossomClient';
import {
	MULTI_DEVICE_TIP_KIND,
	type MultiDeviceOwnerConfig
} from '$lib/services/multiDevice.svelte';

export interface RelayTipProbe {
	relay: string;
	/** Outer tip event id that relay served, or null if it has nothing. */
	eventId: string | null;
	createdAt: number | null;
}

export interface BlobProbe {
	server: string;
	address: string;
	kind: 'group' | 'meta';
	gid?: string;
	present: boolean;
	status: number;
	size: number | null;
	reason?: string;
}

/**
 * Fetch the latest tip from ONE relay (mirrors `fetchLatestTipEvent`'s
 * accumulate-max-created_at + hard-timeout pattern, scoped to a single relay so
 * the caller keeps source attribution). Resolves null if the relay has nothing.
 */
async function fetchLatestTipFromRelay(
	relay: string,
	config: MultiDeviceOwnerConfig
): Promise<NostrEvent | null> {
	let latest: NostrEvent | null = null;
	await new Promise<void>((resolve) => {
		const sub = relayPool
			.request(
				[relay],
				{
					kinds: [MULTI_DEVICE_TIP_KIND],
					authors: [config.ephemeralPubkey],
					'#d': [config.dTag]
				},
				{ reconnect: 1, timeout: 5000 }
			)
			.subscribe({
				next: (event) => {
					if (!latest || event.created_at > latest.created_at) latest = event;
				},
				complete: () => resolve(),
				error: () => resolve()
			});
		// ponytail: hard 5.5s cap in case the relay neither EOSEs nor errors.
		setTimeout(() => {
			try {
				sub.unsubscribe();
			} catch {
				/* best-effort */
			}
			resolve();
		}, 5500);
	});
	return latest;
}

/** Per-relay tip presence (parallel). Each row is the tip that relay served. */
export async function probeRelayTips(config: MultiDeviceOwnerConfig): Promise<RelayTipProbe[]> {
	return Promise.all(
		config.relays.map(async (relay) => {
			const ev = await fetchLatestTipFromRelay(relay, config);
			return {
				relay,
				eventId: ev?.id ?? null,
				createdAt: ev?.created_at ?? null
			};
		})
	);
}

/**
 * Per-(address × server) blob presence via BUD-01 HEAD. Parallel across all
 * pairs; one HEAD each, no body download. Returns one row per pair.
 */
export async function probeBlossomBlobs(config: MultiDeviceOwnerConfig): Promise<BlobProbe[]> {
	const tip = config.lastSeenTip;
	if (!tip) return [];
	const targets: { address: string; kind: 'group' | 'meta'; gid?: string }[] = [
		...tip.groups.map((g) => ({ address: g.address, kind: 'group' as const, gid: g.gid })),
		...(tip.metaAddress ? [{ address: tip.metaAddress, kind: 'meta' as const }] : [])
	];
	const pairs = targets.flatMap((t) => config.blossomServers.map((server) => ({ ...t, server })));
	return Promise.all(
		pairs.map(async (p) => {
			const r = await hasBlob(p.server, p.address);
			return {
				server: p.server,
				address: p.address,
				kind: p.kind,
				gid: p.gid,
				present: r.ok,
				status: r.status,
				size: r.size,
				reason: r.reason
			};
		})
	);
}
