import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { LocalNotifications } from '@capacitor/local-notifications';
import { CordnBackground, type DeliveryMode, type PollGroup } from 'cordn-background';
import type { AppInfo } from 'nostr-signer-capacitor-plugin';
import { manager } from '$lib/services/accountManager.svelte';
import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
import {
	ingestIncomingChatGroupMessages,
	listChatGroups,
	listChatGroupMembers
} from '$lib/services/chatGroups.svelte';
import { getChatGroupDisplayTitle } from '$lib/components/chat/chatGroupDisplay';
import { defaultRelays } from '$lib/services/relay-pool';
import { normalizePubKey } from '$lib/utils';

/**
 * Native-shell seam. Web is a no-op everywhere here; the native branches run only inside the
 * Capacitor Android shell. Centralizes the surface that differs between the browser (Notification
 * API, no status bar, no background execution) and Android WebView (local notifications, status
 * bar, and a native background poll worker).
 *
 * Design invariants (roadmap §11):
 *  - the only native-aware divergence in the TS app is this module + its `isNativePlatform()` guards,
 *  - the sidecar is drained in exactly one place (foreground catch-up) and fed to the single MLS
 *    ingestion path (`ingestIncomingChatGroupMessages`),
 *  - the background poll is key-less (throwaway signer); no user secrets cross this seam.
 */

/** True only inside the Capacitor native shell (Android). Web/PWA → false. */
export function isNativePlatform(): boolean {
	return browser && Capacitor.isNativePlatform();
}

let initialized = false;

/**
 * Whether the app is foregrounded on native. Defaults true (foreground at load); updated by the
 * appStateChange listener. Foreground notifications are suppressed — the in-app title badge /
 * unread dots already surface attention, so a system toast is just noise (roadmap UX note).
 */
let appActive = true;

/**
 * One-time native-shell bootstrap. No-op on web. Idempotent.
 * - styles the status bar, hides the launch splash, arms notification permission + tap routing,
 * - schedules the background poll worker and drains any sidecar staged while the app was closed,
 * - wires the app lifecycle so backgrounding seeds the poll set and foregrounding drains + re-seeds.
 *
 * Called from the root layout onMount.
 */
export async function initNativeShell(): Promise<void> {
	if (!isNativePlatform() || initialized) return;
	initialized = true;

	try {
		await StatusBar.setStyle({ style: Style.Default });
	} catch {
		// status bar unavailable — non-fatal
	}

	try {
		await SplashScreen.hide({ fadeOutDuration: 200 });
	} catch {
		// no splash configured — ignore
	}

	try {
		await LocalNotifications.requestPermissions();
	} catch {
		// permission re-requested lazily on first showLocalNotification
	}

	// --- Phase 2/3: background delivery + sidecar ---
	void applyDeliveryConfig();
	void drainBackgroundSidecar(); // ingest anything staged while the app was closed
	void seedBackground();

	try {
		await App.addListener('appStateChange', ({ isActive }) => {
			appActive = isActive;
			// Background → seed the poll set with the latest cursors.
			// Foreground → drain staged bytes (catch-up) then re-seed.
			if (isActive) {
				void drainBackgroundSidecar().then(() => void seedBackground());
			} else {
				void seedBackground();
			}
		});
	} catch {
		// lifecycle listener unavailable — init-time seed/drain still covers cold start
	}
}

// ───────────────────────────── android native signer (NIP-55) ─────────────────────────────

/**
 * Installed Android signer app (Amber, etc.) discovered via NIP-55. `import type` keeps the
 * capacitor plugin out of the web bundle — the runtime import lives inside the native guard.
 */
export type InstalledSignerApp = AppInfo;

/**
 * True inside the Capacitor Android shell specifically (not iOS, not web). NIP-55 is
 * Android-only, so UI gates on this rather than the broader `isNativePlatform()`.
 */
export function isAndroidNative(): boolean {
	return isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/**
 * Enumerate signer apps installed on the device that can serve NIP-55 sign requests. Web/iOS →
 * empty. Best-effort: a missing plugin or zero installed signers resolves to `[]` so the caller
 * can treat "no signer apps" the same as "not native" and hide the section.
 */
export async function getInstalledSignerApps(): Promise<InstalledSignerApp[]> {
	if (!isAndroidNative()) return [];
	try {
		const { AndroidNativeAccount } =
			await import('applesauce-accounts/accounts/android-native-account');
		return await AndroidNativeAccount.getSignerApps();
	} catch (error) {
		console.warn('[native] failed to enumerate Android signer apps', error);
		return [];
	}
}

/**
 * Pair with an installed Android signer app via NIP-55: prompts the signer (Amber) for the
 * user's pubkey, builds an `AndroidNativeAccount`, and activates it. The account persists via
 * the manager's toJSON/fromJSON (just `{ packageName }` — no secret crosses the bridge), so
 * relaunch re-binds to the signer lazily on the next sign/decrypt without re-prompting.
 */
export async function connectAndroidSigner(app: InstalledSignerApp): Promise<void> {
	if (!isAndroidNative()) return;
	const { AndroidNativeAccount } =
		await import('applesauce-accounts/accounts/android-native-account');
	const account = await AndroidNativeAccount.fromApp(app);
	manager.addAccount(account);
	manager.setActive(account);
}

// ───────────────────────────── foreground notifications ─────────────────────────────

export interface ChatLocalNotification {
	title: string;
	body: string;
	/** Web only: group/favicon icon URL. Native reads its icon from the cache (NativeGroupMetaSync). */
	icon?: string;
	/** Stable group id — dedup tag (web) and coalescing id (native). */
	groupId: string;
}

export async function ensureNotificationPermission(): Promise<boolean> {
	if (!browser) return false;
	if (isNativePlatform()) {
		try {
			const { display } = await LocalNotifications.requestPermissions();
			return display === 'granted';
		} catch {
			return false;
		}
	}
	if (!('Notification' in window)) return false;
	if (Notification.permission !== 'default') return Notification.permission === 'granted';
	return (await Notification.requestPermission()) === 'granted';
}

export async function showLocalNotification(n: ChatLocalNotification): Promise<void> {
	if (!browser) return;
	if (isNativePlatform()) {
		// Suppress while foregrounded — the in-app UI already surfaces attention (title badge, unread dots).
		if (appActive) return;
		// Unified native renderer (same icon/channel/format as the background worker). The icon comes
		// from the native cache (NativeGroupMetaSync), not passed here — Capacitor LocalNotifications
		// ignored the web `icon` field anyway, which is why live-path notifications used to have no
		// icon. Web stays on the browser Notification API below.
		void postMessageNotification(n.groupId, n.title || 'Cordn', n.body);
		return;
	}
	if (!('Notification' in window) || Notification.permission !== 'granted') return;
	const notification = new Notification(n.title || 'Cordn', {
		body: n.body,
		icon: n.icon,
		tag: `cordn-group-${n.groupId}`
	});
	notification.onclick = () => {
		window.focus();
		goto(resolve('/chat/[id]', { id: n.groupId }));
	};
}

// ───────────────────────────── unified native poster + dedupe (notification consolidation) ─────────────────────────────

/**
 * Post a native message notification via the unified native renderer — identical icon/channel/
 * format to the background worker. Native-only; web stays on the browser Notification API. The
 * icon is read from the native cache (kept fresh by NativeGroupMetaSync), so no icon crosses the
 * bridge here. Collapses the old two-renderer drift (live path via Capacitor LocalNotifications,
 * worker via NotificationCompat) into one.
 */
export async function postMessageNotification(
	gid: string,
	title: string,
	body: string
): Promise<void> {
	if (!isNativePlatform()) return;
	try {
		await CordnBackground.postMessageNotification({ gid, title, body });
	} catch {
		// never block chat on a failed notification
	}
}

/**
 * Advance the worker's nativeCursor to [cursor] so it skips messages the live ingestion path
 * already handled. Kills the double-notify: a message that arrives in the grace period used to
 * be posted by the live path (decrypted) and then again ~one cycle later by the worker (count)
 * because nativeCursor lagged behind fetchCursor. MAX-clamped on the native side.
 */
export async function advanceNativeCursor(gid: string, cursor: number): Promise<void> {
	if (!isNativePlatform()) return;
	try {
		await CordnBackground.advanceNativeCursor({ gid, cursor });
	} catch {
		// best-effort — a missed advance just risks one redundant worker notification
	}
}

// ───────────────────────────── background poll + sidecar (Phase 2) ─────────────────────────────

/**
 * The app's true local high-watermark for a group. Outbound sends advance `lastCursor` but not
 * `fetchCursor` (roadmap §5), so the fetch watermark alone leaves own messages above it and the
 * worker would re-notify on them. Shared by the seed (`gatherPollGroups`) and the live-path dedupe.
 */
export function groupFetchWatermark(group: { fetchCursor: number; lastCursor: number }): number {
	return Math.max(group.fetchCursor, group.lastCursor);
}

/** Gather the poll set: per group, its coordinator routing + the app's fetchCursor watermark. */
function gatherPollGroups(): PollGroup[] {
	const activePubkey = manager.active?.pubkey;
	return listChatGroups().map((group) => {
		const coordinator = getChatCoordinator(group.coordinatorKey);
		const relayUrls = coordinator?.relays?.length ? coordinator.relays : defaultRelays;
		const memberPubkeys = listChatGroupMembers(group.id)
			.map((m) => normalizePubKey(m.stablePubkey))
			.filter((p): p is string => Boolean(p));
		return {
			gid: group.id,
			fetchCursor: groupFetchWatermark(group),
			title: getChatGroupDisplayTitle({ group, activePubkey, memberPubkeys }),
			coordinatorServerPubkey: group.coordinatorKey, // the coordinatorKey *is* the server pubkey
			relayUrls
		};
	});
}

// ───────────────────────────── delivery mode (Phase 3B) ─────────────────────────────

const DELIVERY_MODE_KEY = 'cordn.deliveryMode';

/** Default = Fast @ 5 min (foreground service) + WorkManager 15-min backstop (roadmap §4.2). */
export const DEFAULT_DELIVERY: DeliveryConfig = { mode: 'fast', intervalMinutes: 5 };

export interface DeliveryConfig {
	mode: DeliveryMode;
	/** Minutes between foreground-service polls. Only meaningful for `fast`. */
	intervalMinutes: number;
}

/** Read the stored choice (sync, localStorage). Off-web → default. */
export function getDeliveryConfig(): DeliveryConfig {
	if (!browser) return { ...DEFAULT_DELIVERY };
	try {
		const raw = localStorage.getItem(DELIVERY_MODE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed?.mode === 'off' || parsed?.mode === 'standard' || parsed?.mode === 'fast') {
				return { mode: parsed.mode, intervalMinutes: parsed.intervalMinutes ?? 5 };
			}
		}
	} catch {
		// corrupt entry — fall through to default
	}
	return { ...DEFAULT_DELIVERY };
}

/** Persist the choice + push it to native (start/stop the service, reschedule WorkManager). */
export async function setDeliveryConfig(cfg: DeliveryConfig): Promise<void> {
	if (!browser) return;
	localStorage.setItem(DELIVERY_MODE_KEY, JSON.stringify(cfg));
	if (!isNativePlatform()) return;
	try {
		await CordnBackground.configureDelivery({
			mode: cfg.mode,
			intervalMinutes: cfg.intervalMinutes
		});
	} catch {
		// plugin unavailable — foreground-only mode
	}
}

/** Re-apply the stored mode (called on app launch). */
export async function applyDeliveryConfig(): Promise<void> {
	if (!isNativePlatform()) return;
	await setDeliveryConfig(getDeliveryConfig());
}

// ───────────────────────────── group metadata cache (Phase 3A) ─────────────────────────────

/**
 * Refresh one group's cached display title + icon bytes (rendered by the WebView) so the
 * key-less background worker can render a rich notification. Hash-gated by the caller
 * (NativeGroupMetaSync) to avoid spamming the bridge on profile re-emits.
 */
export async function syncGroupMeta(
	gid: string,
	title: string | undefined,
	iconBytes: string | null
): Promise<void> {
	if (!isNativePlatform()) return;
	try {
		await CordnBackground.upsertGroupMeta({
			gid,
			title,
			iconBytes: iconBytes ?? undefined
		});
	} catch {
		// best-effort — a missed sync self-corrects on the next change
	}
}

/** Push the group set + cursors to the native layer. Call on backgrounding and foregrounding. */
export async function seedBackground(): Promise<void> {
	if (!isNativePlatform()) return;
	const accountPubkey = manager.active?.pubkey;
	if (!accountPubkey) return;
	try {
		await CordnBackground.seed({ accountPubkey, groups: gatherPollGroups() });
	} catch {
		// best-effort — a missed seed self-corrects on the next transition
	}
}

/**
 * Drain the sidecar and feed staged bytes into the single MLS ingestion path. This is the
 * *only* place the sidecar is drained (roadmap §11.2). Maps the wire format to the ingestion
 * shape exactly as the network path does (at→createdAt, msg_64→opaqueMessageBase64).
 */
export async function drainBackgroundSidecar(): Promise<void> {
	if (!isNativePlatform()) return;
	let drained;
	try {
		drained = await CordnBackground.drain();
	} catch {
		return;
	}
	if (!drained.messages.length) return;

	const byGid = new Map<string, typeof drained.messages>();
	for (const m of drained.messages) {
		const arr = byGid.get(m.gid);
		if (arr) arr.push(m);
		else byGid.set(m.gid, [m]);
	}
	for (const [gid, rows] of byGid) {
		try {
			await ingestIncomingChatGroupMessages(
				gid,
				rows.map((m) => ({
					cursor: m.cursor,
					createdAt: m.at,
					opaqueMessageBase64: m.msg64
				}))
			);
		} catch {
			// a single group failing to ingest must not block the rest
		}
	}
}
