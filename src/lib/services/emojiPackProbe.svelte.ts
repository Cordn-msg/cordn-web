import { SvelteMap } from 'svelte/reactivity';

import { fetchEmojiImage } from '$lib/services/chatEmojiImage';

/**
 * Whether this device can read a pack's pictures for encrypted sending.
 *
 * CORS and hosting are properties of a host, so one probe per origin covers
 * every pack on it: a pack of 30 emoji costs one capped request, not 30. Probes
 * only run when a card is actually on screen (see EmojiPackCompatibility.svelte)
 * and an `ok` is remembered for the session while a `failed` is remembered for
 * a few minutes, so scrolling a grid or re-running a discovery search never
 * turns into a request storm.
 *
 * A probe proves the picture it fetched, not the whole pack: a different path,
 * redirect or oversized image on the same host can still fail at send time,
 * which `noteEmojiSendFailure()` records here too.
 */
export type EmojiProbeState = 'checking' | 'ok' | 'failed';

const FAILED_TTL_MS = 5 * 60_000;

const states = new SvelteMap<string, { state: EmojiProbeState; at: number }>();
const inFlight = new Set<string>();

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return '';
	}
}

/** The state for the host behind [url]; undefined when this session never asked. */
/** The picture a card probes and shows its badge for. */
export function packProbeUrl(pack: { emoji: { url: string }[] }): string {
	return pack.emoji[0]?.url ?? '';
}

/** 1 when this pack's host is known to refuse this browser, 0 otherwise — sorts
 *  unsendable packs to the bottom of a list without disturbing the rest. */
export function packProbeRank(pack: { emoji: { url: string }[] }): number {
	const url = packProbeUrl(pack);
	return url && emojiProbeState(url) === 'failed' ? 1 : 0;
}

export function emojiProbeState(url: string): EmojiProbeState | undefined {
	return states.get(originOf(url))?.state;
}

/** Probe [url]'s host unless a recent answer already exists. `force` re-asks
 *  after a failure (the "Check again" affordance). */
export function probeEmojiUrl(url: string, options: { force?: boolean } = {}): void {
	const origin = originOf(url);
	if (!origin || inFlight.has(origin)) return;
	const known = states.get(origin);
	if (known && !options.force) {
		if (known.state === 'ok' || known.state === 'checking') return;
		if (Date.now() - known.at < FAILED_TTL_MS) return;
	}
	inFlight.add(origin);
	states.set(origin, { state: 'checking', at: Date.now() });
	void fetchEmojiImage(url).then(
		() => {
			inFlight.delete(origin);
			states.set(origin, { state: 'ok', at: Date.now() });
		},
		() => {
			inFlight.delete(origin);
			states.set(origin, { state: 'failed', at: Date.now() });
		}
	);
}

/** A real send is better evidence than a probe — record both outcomes. */
export function noteEmojiSendFailure(url: string): void {
	const origin = originOf(url);
	if (origin) states.set(origin, { state: 'failed', at: Date.now() });
}

export function noteEmojiSendSuccess(url: string): void {
	const origin = originOf(url);
	if (origin) states.set(origin, { state: 'ok', at: Date.now() });
}
