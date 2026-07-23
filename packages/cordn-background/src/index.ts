import { type PluginListenerHandle, registerPlugin } from '@capacitor/core';

/**
 * TS↔Kotlin bridge for background message polling. The *only* boundary between the
 * WebView (TS) and the native poll worker (Kotlin + Rust via UniFFI). All methods reject
 * on web — the app guards every call with `isNativePlatform()` (nativeBridge.ts), so they
 * never execute outside the Android shell.
 *
 * Design (roadmap §4.2, §5, §6, §8, §11):
 *  - `configureDelivery` → set the delivery mode (off / standard / fast) + fast interval; starts
 *                           or stops the foreground service and reschedules WorkManager.
 *  - `seed`              → push the group set + the app's watermark + display names + per-coordinator
 *                           routing; native seeds/resyncs `nativeCursor` to it (max(existing, watermark),
 *                           so it never moves backward).
 *  - `upsertGroupMeta`   → refresh one group's cached display title + icon bytes (rendered by the
 *                           WebView) so the key-less worker can render a rich notification.
 *  - `drain`             → pull staged coordinator wire-format bytes (the sidecar) and clear them;
 *                           the foreground catch-up feeds them to `ingestIncomingChatGroupMessages`.
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

/** Delivery mode spectrum (roadmap §4.2). `live` is deferred (Phase 3C, spike-gated). */
export type DeliveryMode = 'off' | 'standard' | 'fast';

export interface CordnBackgroundDeliveryOptions {
	/** off = no background polling; standard = WorkManager ~15 min only; fast = foreground service. */
	mode: DeliveryMode;
	/** Minutes between foreground-service polls. Only meaningful for `fast`. Default 5. */
	intervalMinutes: number;
}

export interface CordnBackgroundSeedOptions {
	/** Active account pubkey — the sidecar is namespaced per account. */
	accountPubkey: string;
	groups: PollGroup[];
}

export interface CordnBackgroundMetaOptions {
	gid: string;
	/** Best display title (group name, member names, etc.) — null/undefined clears it. */
	title?: string;
	/** Base64 PNG bytes of the rendered group icon (no data: prefix). null/undefined clears it. */
	iconBytes?: string;
}

export interface CordnBackgroundPostNotificationOptions {
	/** Coordinator group id — the per-group notification key (a burst coalesces; latest wins). */
	gid: string;
	/** Group display title. Falls back to the cached title (or "Cordn") on native. */
	title?: string;
	/** Message body — decrypted preview from the live path, or a count from the worker. */
	body?: string;
}

export interface CordnBackgroundAdvanceCursorOptions {
	gid: string;
	/** The cursor to advance the worker's nativeCursor to (MAX-clamped; never moves backward). */
	cursor: number;
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

export interface CordnBackgroundBatteryResult {
	exempted: boolean;
}

// ───────────────────────────── share target (Android SEND intent) ─────────────────────────────

/** A share captured from the Android SEND intent (another app → Cordn). Text-only in v1. */
export interface ShareTargetPendingShare {
	/** Shared text/URL payload from Intent.EXTRA_TEXT. Absent when nothing is pending. */
	text?: string;
}

export interface ShareTargetPlugin {
	/** Drain + return the text captured from an Android SEND intent, if any. Consumed once. */
	consumePendingShare(): Promise<ShareTargetPendingShare>;
}

export interface CordnBackgroundPlugin {
	/** Set the delivery mode + fast interval; starts/stops the foreground service accordingly. */
	configureDelivery(options: CordnBackgroundDeliveryOptions): Promise<void>;
	/** Push the group set + cursors + routing. Call on account/group change and backgrounding. */
	seed(options: CordnBackgroundSeedOptions): Promise<void>;
	/** Refresh one group's cached title + icon bytes (rendered by the WebView). */
	upsertGroupMeta(options: CordnBackgroundMetaOptions): Promise<void>;
	/** Post a unified native message notification (title + body; icon from the native cache). */
	postMessageNotification(options: CordnBackgroundPostNotificationOptions): Promise<void>;
	/** Advance the worker's nativeCursor so it skips messages the live path already handled. */
	advanceNativeCursor(options: CordnBackgroundAdvanceCursorOptions): Promise<void>;
	/** Consume + return the group id captured from a notification-tap launch (deep-link routing). */
	consumeLaunchGid(): Promise<{ gid: string | null }>;
	/** Pull staged sidecar rows (wire format) and clear them. Call on foreground catch-up. */
	drain(): Promise<CordnBackgroundDrainResult>;
	/** Whether this app is exempt from battery optimization (Doze). */
	isBatteryExempted(): Promise<CordnBackgroundBatteryResult>;
	/** Launch the system "disable battery optimization for Cordn" prompt. */
	requestBatteryExemption(): Promise<void>;
	/** Fired when the background worker stages new sidecar bytes while the app is foregrounded. */
	addListener(
		eventName: 'sidecarUpdated',
		listener: () => void
	): Promise<PluginListenerHandle>;
}

export const CordnBackground = registerPlugin<CordnBackgroundPlugin>('CordnBackground');

/** Android SEND share-target plugin (auto-discovered via the `ShareTarget` @CapacitorPlugin name). */
export const ShareTarget = registerPlugin<ShareTargetPlugin>('ShareTarget');
