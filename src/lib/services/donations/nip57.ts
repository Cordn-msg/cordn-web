/**
 * NIP-57 Lightning zap primitives. Ported from the ContextVM SDK reference
 * (`payments/nip57/`); kept dependency-free apart from `nostr-tools`.
 *
 * Flow: resolve a LUD-16 lightning address to LNURL-pay params, sign a kind-9734
 * zap request, send it to the pay `callback` to obtain a BOLT11 invoice, then
 * match a kind-9735 zap receipt (published by the recipient's LNURL server) by
 * its `bolt11` tag.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/57.md
 */

import { kinds, type NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, type EventTemplate } from 'nostr-tools/pure';

export interface LnurlPayParams {
	callback: string;
	allowsNostr?: boolean;
	nostrPubkey?: string;
	minSendable?: number;
	maxSendable?: number;
}

export function parseLnAddress(lnAddress: string): { username: string; domain: string } {
	const parts = lnAddress.split('@');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`Invalid lightning address: ${lnAddress}`);
	}
	return { username: parts[0], domain: parts[1] };
}

/** Resolve a LUD-16 address to its LNURL-pay params via `.well-known/lnurlp`. */
export async function fetchLnurlPayParams(lnAddress: string): Promise<LnurlPayParams> {
	const { username, domain } = parseLnAddress(lnAddress);
	const url = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`;

	const response = await fetch(url, { method: 'GET' });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`LNURL-pay fetch failed: ${response.status} ${text}`);
	}

	const json = (await response.json()) as LnurlPayParams;
	if (!json.callback) {
		throw new Error('LNURL-pay response missing callback');
	}
	return json;
}

/**
 * Request a BOLT11 invoice from the LNURL-pay `callback`. When `zapRequestJson`
 * is provided the invoice is a NIP-57 zap invoice (the `nostr` query param is
 * included); otherwise it is a plain LNURL-pay invoice with no Nostr event.
 */
export async function requestLnurlInvoice(params: {
	callback: string;
	amountMsats: number;
	zapRequestJson?: string;
}): Promise<{ pr: string }> {
	const url = new URL(params.callback);
	url.searchParams.set('amount', params.amountMsats.toString());
	if (params.zapRequestJson) {
		url.searchParams.set('nostr', params.zapRequestJson);
	}

	const response = await fetch(url.toString(), { method: 'GET' });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`LNURL callback failed: ${response.status} ${text}`);
	}

	const json = (await response.json()) as { pr?: string; reason?: string };
	if (!json.pr) {
		throw new Error(`LNURL callback missing pr${json.reason ? `: ${json.reason}` : ''}`);
	}
	return { pr: json.pr };
}

/** Build an unsigned kind-9734 zap request template (NIP-57 Appendix A). */
export function createZapRequest(params: {
	amountMsats: number;
	recipientPubkey: string;
	relays: string[];
	/** Optional zap comment (carried in the receipt's `description`). */
	content?: string;
}): EventTemplate {
	return {
		kind: kinds.ZapRequest,
		created_at: Math.floor(Date.now() / 1000),
		content: params.content ?? '',
		tags: [
			['relays', ...params.relays],
			['amount', params.amountMsats.toString()],
			['p', params.recipientPubkey]
		]
	};
}

/** Extract the `bolt11` invoice from a kind-9735 zap receipt. */
export function getBolt11FromZapReceipt(event: NostrEvent): string | undefined {
	return event.tags.find((t) => t[0] === 'bolt11')?.[1];
}

/**
 * Parse the embedded kind-9734 zap request from a kind-9735 receipt's
 * `description` tag (NIP-57 Appendix E). The zap request carries the sender
 * (`pubkey`) and the optional zap comment (`content`). Returns `null` if the
 * tag is missing, malformed, or lacks a sender.
 */
export function getZapRequestFromReceipt(event: NostrEvent): NostrEvent | null {
	const description = event.tags.find((t) => t[0] === 'description')?.[1];
	if (!description) return null;
	try {
		const parsed = JSON.parse(description) as NostrEvent;
		return parsed && parsed.pubkey ? parsed : null;
	} catch {
		return null;
	}
}

/** Sign a zap request with a fresh ephemeral key (anonymous zaps). */
export function signZapRequestAnonymously(template: EventTemplate): NostrEvent {
	return finalizeEvent(template, generateSecretKey());
}
