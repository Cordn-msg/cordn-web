import { registerPlugin } from '@capacitor/core';

/**
 * TS↔Kotlin bridge for background message polling. The *only* boundary between the
 * WebView (TS) and the native poll worker (Kotlin + Rust via UniFFI). All methods reject
 * on web — the app guards every call with `isNativePlatform()` (nativeBridge.ts), so they
 * never execute outside the Android shell.
 *
 * Design (roadmap §5, §6, §8, §11):
 *  - `configure` → schedule the WorkManager periodic worker.
 *  - `seed`      → push the group set + the app's `fetchCursor` watermark + display names
 *                  + per-coordinator routing; native seeds/resyncs `nativeCursor` to it
 *                  (nativeCursor = max(existing, fetchCursor), so it never moves backward).
 *  - `drain`     → pull staged coordinator wire-format bytes (the sidecar) and clear them;
 *                  the foreground catch-up maps them to the ingestion shape and feeds them
 *                  to `ingestIncomingChatGroupMessages` (the single MLS ingestion path).
 *
 * The sidecar is a replay buffer of the wire format, never a parallel data model.
 */

/** One group the native poller watches, with its coordinator routing. */
export interface PollGroup {
	/** Coordinator group id. */
	gid: string;
	/** The app's current fetch watermark; native seeds/resyncs nativeCursor to it. */
	fetchCursor: number;
	/** Display name for the notification (native caches the last-seen value). */
	title?: string;
	/** Coordinator server pubkey (hex) — the group's coordinator. */
	coordinatorServerPubkey: string;
	/** Operational relay URLs for this group's coordinator (empty → CEP-17 discovery). */
	relayUrls: string[];
}

export interface CordnBackgroundConfigureOptions {
	/** Poll interval in minutes (Android WorkManager floors this at 15). Default 15. */
	pollIntervalMinutes?: number;
}

export interface CordnBackgroundSeedOptions {
	/** Active account pubkey — the sidecar is namespaced per account. */
	accountPubkey: string;
	groups: PollGroup[];
}

/** A staged coordinator wire-format row (encrypted MLS ciphertext, undecrypted). */
export interface StagedMessage {
	gid: string;
	cursor: number;
	/** Base64 of the raw encrypted message bytes (`msg_64` on the wire). */
	msg64: string;
	/** Coordinator timestamp in seconds (wire `at`). */
	at: number;
}

export interface CordnBackgroundDrainResult {
	accountPubkey: string | null;
	messages: StagedMessage[];
}

export interface CordnBackgroundPlugin {
	/** Schedule the periodic worker. Idempotent (unique work, KEEP). */
	configure(options: CordnBackgroundConfigureOptions): Promise<void>;
	/** Push the group set + cursors + routing. Call on account/group change and backgrounding. */
	seed(options: CordnBackgroundSeedOptions): Promise<void>;
	/** Pull staged sidecar rows (wire format) and clear them. Call on foreground catch-up. */
	drain(): Promise<CordnBackgroundDrainResult>;
}

export const CordnBackground = registerPlugin<CordnBackgroundPlugin>('CordnBackground');
