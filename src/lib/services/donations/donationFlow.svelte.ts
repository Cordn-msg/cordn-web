/**
 * Donation flow state machine for NIP-57 Lightning zaps.
 *
 * One global rune-driven store ({@link donationFlow}) backs the donation dialog.
 * `startDonation()` resolves the recipient's LNURL-pay params, signs a zap
 * request (with the active account, or an ephemeral key for anonymous zaps),
 * fetches a BOLT11 invoice, and then subscribes for the matching kind-9735 zap
 * receipt until it arrives or the listen window elapses.
 *
 * - {@link teardown} is silent: it only clears the subscription + timer and never
 *   sets a phase. The "couldn't confirm" failure can only come from the listen
 *   timeout, so cancelling an in-flight flow (dialog close, retry) never
 *   surfaces a spurious error.
 * - A monotonically increasing {@link runId} invalidates stale async runs so a
 *   superseded `startDonation` stops touching phase state.
 */

import { browser } from '$app/environment';
import { manager } from '$lib/services/accountManager.svelte';
import { commonRelays, relayPool } from '$lib/services/relay-pool';
import { parseBolt11 } from 'applesauce-common/helpers/bolt11';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { satsToMsats, msatsToSats } from './amounts';
import {
	createZapRequest,
	fetchLnurlPayParams,
	getBolt11FromZapReceipt,
	requestLnurlInvoice,
	signZapRequestAnonymously
} from './nip57';

/** How long to keep listening for a zap receipt. Donations are usually paid in seconds. */
const MAX_LISTEN_MS = 15 * 60 * 1000;

export interface DonationFlowOptions {
	lnAddress: string;
	/** NIP-57 recipient pubkey (hex) — the zap request `p` tag. */
	recipientPubkey: string;
	amountSats: number;
	message: string;
	anonymous: boolean;
	/**
	 * When `true`, sign and send a NIP-57 zap request (verifiable on Nostr). When
	 * `false`, request a plain LNURL-pay invoice with no Nostr event — private,
	 * but not auto-confirmable (no kind-9735 receipt is produced).
	 */
	publishEvent: boolean;
}

export type DonationPhase =
	| { kind: 'idle' }
	| { kind: 'preparing' }
	| {
			kind: 'awaiting-payment';
			invoice: string;
			expiryAt: number;
			amountSats: number;
			/** Whether the invoice can be auto-confirmed via a kind-9735 receipt. */
			confirmable: boolean;
	  }
	| { kind: 'confirmed'; amountSats: number }
	| { kind: 'failed'; error: string };

export const donationFlow = $state<{ phase: DonationPhase }>({ phase: { kind: 'idle' } });

let activeSubscription: { unsubscribe: () => void } | null = null;
let verificationTimer: ReturnType<typeof setTimeout> | null = null;

/** Invalidates in-flight async runs; stale runs bail out by rechecking runId. */
let runId = 0;

function setPhase(phase: DonationPhase) {
	donationFlow.phase = phase;
}

/** Whether the active account (if any) can sign events. */
export function canSignWithActiveAccount(): boolean {
	return browser && !!manager.getActive();
}

/** Cancel any in-flight run, clear verification, and return to idle. Never errors. */
export function resetDonationFlow() {
	runId++;
	teardown();
	setPhase({ kind: 'idle' });
}

function teardown() {
	if (verificationTimer) {
		clearTimeout(verificationTimer);
		verificationTimer = null;
	}
	if (activeSubscription) {
		try {
			activeSubscription.unsubscribe();
		} catch {
			// best-effort
		}
		activeSubscription = null;
	}
}

async function signZapRequest(template: EventTemplate, anonymous: boolean): Promise<NostrEvent> {
	if (anonymous) return signZapRequestAnonymously(template);
	const account = manager.getActive();
	if (!account) return signZapRequestAnonymously(template);
	try {
		return await account.signer.signEvent(template);
	} catch (error) {
		throw new Error(
			`Couldn't sign the zap request with your account. Try enabling anonymous zap.${
				error instanceof Error ? ` (${error.message})` : ''
			}`,
			{ cause: error }
		);
	}
}

export async function startDonation(options: DonationFlowOptions) {
	runId++;
	teardown();
	const myRun = runId;

	setPhase({ kind: 'preparing' });
	const amountMsats = satsToMsats(options.amountSats);

	try {
		const payParams = await fetchLnurlPayParams(options.lnAddress);
		if (myRun !== runId) return;
		if (!payParams.allowsNostr || !payParams.nostrPubkey) {
			throw new Error('This lightning address does not support NIP-57 zaps.');
		}
		if (typeof payParams.minSendable === 'number' && amountMsats < payParams.minSendable) {
			// Round up: the smallest whole-sat amount that satisfies the msat minimum.
			throw new Error(`Minimum donation is ${Math.ceil(payParams.minSendable / 1000)} sats.`);
		}
		if (typeof payParams.maxSendable === 'number' && amountMsats > payParams.maxSendable) {
			throw new Error(`Maximum donation is ${msatsToSats(payParams.maxSendable)} sats.`);
		}

		// A direct invoice (no zap event) carries no kind-9735 receipt, so it
		// cannot be auto-confirmed; a zap invoice is verifiable on Nostr.
		let zapRequestJson: string | undefined;
		if (options.publishEvent) {
			const zapRequest = await signZapRequest(
				createZapRequest({
					amountMsats,
					recipientPubkey: options.recipientPubkey,
					relays: commonRelays,
					content: options.message.trim() || undefined
				}),
				options.anonymous
			);
			if (myRun !== runId) return;
			zapRequestJson = JSON.stringify(zapRequest);
		}

		const { pr: invoice } = await requestLnurlInvoice({
			callback: payParams.callback,
			amountMsats,
			zapRequestJson
		});
		if (myRun !== runId) return;

		const expirySeconds = parseBolt11(invoice).expiry || Math.floor(Date.now() / 1000) + 600;
		setPhase({
			kind: 'awaiting-payment',
			invoice,
			expiryAt: expirySeconds * 1000,
			amountSats: options.amountSats,
			confirmable: options.publishEvent
		});

		if (options.publishEvent) {
			startVerification(invoice, payParams.nostrPubkey, options.amountSats, myRun);
		}
	} catch (error) {
		if (myRun !== runId) return;
		setPhase({
			kind: 'failed',
			error: error instanceof Error ? error.message : 'Failed to create donation invoice.'
		});
	}
}

function startVerification(
	invoice: string,
	/** Pubkey that authors zap receipts — the LNURL host's `nostrPubkey`. */
	authorPubkey: string,
	amountSats: number,
	myRun: number
) {
	const since = Math.floor(Date.now() / 1000) - 10;

	let settled = false;
	const finish = (phase: DonationPhase) => {
		if (settled || myRun !== runId) return;
		settled = true;
		teardown();
		setPhase(phase);
	};

	activeSubscription = relayPool
		.subscription(commonRelays, { kinds: [9735], authors: [authorPubkey], since })
		.subscribe({
			next: (event: NostrEvent) => {
				if (getBolt11FromZapReceipt(event) === invoice) {
					finish({ kind: 'confirmed', amountSats });
				}
			},
			error: () => {
				// Ignore relay errors; other relays may still deliver the receipt
				// before the listen window elapses.
			}
		});

	verificationTimer = setTimeout(() => {
		finish({
			kind: 'failed',
			error:
				"Couldn't confirm your payment in time. If you paid, it may still come through — start a new donation to retry."
		});
	}, MAX_LISTEN_MS);
}
