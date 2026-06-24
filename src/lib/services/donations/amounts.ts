/**
 * Lightning amount unit conversions.
 *
 * NIP-57 zap amounts and LNURL `minSendable`/`maxSendable` are expressed in
 * millisatoshis; the UI works in whole sats. Centralize the two directions so
 * rounding stays consistent across the donation flow and supporters view.
 */

/** Convert whole sats to millisatoshis. */
export function satsToMsats(sats: number): number {
	return sats * 1000;
}

/** Truncate millisatoshis to whole sats (standard for display/aggregation). */
export function msatsToSats(msats: number): number {
	return Math.floor(msats / 1000);
}
