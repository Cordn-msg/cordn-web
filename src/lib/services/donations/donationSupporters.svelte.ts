/**
 * Aggregate NIP-57 zap receipts targeting the project pubkey into a
 * per-supporter leaderboard, backed by the shared applesauce
 * {@link eventStore} so receipts persist across navigations.
 *
 * `loadSupporters(lnAddress, recipientPubkey)` is idempotent. The first call
 * resolves the host's LNURL-pay params (`nostrPubkey`, the key that authenticates
 * receipts) and opens two persistent, module-level subscriptions keyed by the
 * recipient:
 *
 * 1. A relay subscription piped through {@link mapEventsToStore} so fetched
 *    receipts land in the app-wide {@link eventStore} (no re-fetch on revisit).
 * 2. {@link eventStore.timeline} on the same filter, which emits the cached
 *    snapshot instantly (so reopening renders from cache) plus any new inserts,
 *    reduced into a per-sender leaderboard.
 *
 * The NIP-57 Appendix F query `{ kinds:[9735], '#p':[recipient], authors:[host] }`
 * selects zaps to the project (the `p` tag) authenticated to the host's signing
 * key, so unrelated zaps the host processes for other users are excluded.
 *
 * `createZapsLoader` can't be used here: it matches the `e`/`a` tag on kind 9735
 * (event-targeted zaps), but donations are pubkey-targeted tips whose zap request
 * only carries a `p` tag. The `#p`-scoped subscription is the Appendix F query
 * for "zaps to a pubkey".
 */

import { mapEventsToStore } from 'applesauce-core/observable';
import { eventStore } from '$lib/services/eventStore';
import { commonRelays, relayPool } from '$lib/services/relay-pool';
import { parseBolt11 } from 'applesauce-common/helpers/bolt11';
import type { NostrEvent } from 'nostr-tools';
import { fetchLnurlPayParams, getBolt11FromZapReceipt, getZapRequestFromReceipt } from './nip57';

export interface SupporterAgg {
	pubkey: string;
	/** Total zapped, in millisatoshis. */
	msats: number;
	zapCount: number;
	/** `created_at` of the supporter's most recent zap receipt. */
	lastAt: number;
	/** The supporter's most recent non-empty zap comment, if any. */
	comment?: string;
}

export type SupporterState =
	| { kind: 'loading' }
	| { kind: 'loaded'; supporters: SupporterAgg[] }
	| { kind: 'error'; message: string };

export const supporters = $state<{ state: SupporterState }>({
	state: { kind: 'loading' }
});

/** Persistent relay→store subscription + store aggregation, keyed by recipient. */
let activeRecipient: string | null = null;
let loaderSub: { unsubscribe: () => void } | null = null;
let timelineSub: { unsubscribe: () => void } | null = null;

/**
 * Extract the zap sender, paid amount (msat), and comment from a kind-9735
 * receipt. Returns `null` for receipts we can't attribute or price.
 */
function parseZapReceipt(
	event: NostrEvent
): { sender: string; msats: number; comment: string } | null {
	const bolt11 = getBolt11FromZapReceipt(event);
	const zapRequest = getZapRequestFromReceipt(event);
	if (!bolt11 || !zapRequest) return null;

	let msats: number | undefined;
	try {
		msats = parseBolt11(bolt11).amount;
	} catch {
		// A malformed bolt11 would otherwise throw inside the timeline subscription
		// and tear down the whole leaderboard. Skip the bad receipt instead.
		return null;
	}
	if (!msats || msats <= 0) return null;
	return {
		sender: zapRequest.pubkey,
		msats,
		comment: zapRequest.content?.trim() ?? ''
	};
}

/**
 * Reduce a list of zap receipts into a high→low per-sender leaderboard.
 *
 * Receipts are sorted newest-first, so each supporter's `lastAt` comes from
 * their most recent zap and the first non-empty `comment` seen is their latest
 * comment (older/empty comments are ignored). Uses a null-proto object (not a
 * Map) so the grouping accumulator doesn't trip the svelte/reactivity lint rule,
 * and guards against `__proto__`/`constructor` pubkey collisions.
 */
function aggregate(events: NostrEvent[]): SupporterAgg[] {
	const ordered = [...events].sort((a, b) => b.created_at - a.created_at);
	const bySender = Object.create(null) as Record<string, SupporterAgg>;
	for (const event of ordered) {
		const info = parseZapReceipt(event);
		if (!info) continue;
		const existing = bySender[info.sender];
		if (existing) {
			existing.msats += info.msats;
			existing.zapCount += 1;
			if (!existing.comment && info.comment) existing.comment = info.comment;
		} else {
			bySender[info.sender] = {
				pubkey: info.sender,
				msats: info.msats,
				zapCount: 1,
				lastAt: event.created_at,
				comment: info.comment || undefined
			};
		}
	}
	return Object.values(bySender).sort((a, b) => b.msats - a.msats || b.lastAt - a.lastAt);
}

function teardown() {
	loaderSub?.unsubscribe();
	timelineSub?.unsubscribe();
	loaderSub = null;
	timelineSub = null;
}

/**
 * Ensure zap receipts for `recipientPubkey` are loading and aggregated into
 * {@link supporters}. Idempotent: a repeat call for the same recipient is a
 * no-op, so reopening the page renders from the persistent store with no extra
 * network calls. A new recipient swaps the subscriptions.
 */
export function loadSupporters(lnAddress: string, recipientPubkey: string) {
	if (activeRecipient === recipientPubkey) return;

	teardown();
	activeRecipient = recipientPubkey;
	supporters.state = { kind: 'loading' };

	(async () => {
		try {
			const params = await fetchLnurlPayParams(lnAddress);
			if (activeRecipient !== recipientPubkey) return;
			if (!params.nostrPubkey) {
				supporters.state = {
					kind: 'error',
					message: 'This lightning address does not support zaps.'
				};
				return;
			}

			// NIP-57 Appendix F: `#p` selects zaps to the recipient, `authors`
			// authenticates them to the host's nostrPubkey.
			const filter = {
				kinds: [9735],
				'#p': [recipientPubkey],
				authors: [params.nostrPubkey]
			};

			// Cache snapshot (renders instantly on revisit) + live inserts, reduced
			// into the leaderboard on each change.
			timelineSub = eventStore.timeline(filter).subscribe((events: NostrEvent[]) => {
				if (activeRecipient !== recipientPubkey) return;
				supporters.state = { kind: 'loaded', supporters: aggregate(events) };
			});

			// Fetch from relays and publish into the persistent store; it dedupes
			// inserts, so only genuinely new receipts reach the timeline.
			loaderSub = relayPool
				.subscription(commonRelays, filter)
				.pipe(mapEventsToStore(eventStore))
				.subscribe({
					error: () => {
						// Ignore individual relay errors; the pool may still deliver
						// receipts from other relays.
					}
				});
		} catch (error) {
			if (activeRecipient !== recipientPubkey) return;
			supporters.state = {
				kind: 'error',
				message: error instanceof Error ? error.message : 'Failed to load supporters.'
			};
		}
	})();
}
