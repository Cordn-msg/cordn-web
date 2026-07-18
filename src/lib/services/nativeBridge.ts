import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { LocalNotifications } from '@capacitor/local-notifications';
import { CordnBackground, type PollGroup } from 'cordn-background';
import { manager } from '$lib/services/accountManager.svelte';
import {
	getChatCoordinator
} from '$lib/services/chatCoordinators.svelte';
import {
	ingestIncomingChatGroupMessages,
	listChatGroups
} from '$lib/services/chatGroups.svelte';
import { defaultRelays } from '$lib/services/relay-pool';

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

function groupToNotificationId(groupId: string): number {
	let h = 0;
	for (let i = 0; i < groupId.length; i++) {
		h = (Math.imul(31, h) + groupId.charCodeAt(i)) | 0;
	}
	return Math.abs(h) + 1;
}

let initialized = false;

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

	try {
		await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
			const groupId = event.notification.extra?.groupId as string | undefined;
			if (groupId) goto(resolve('/chat/[id]', { id: groupId }));
		});
	} catch {
		// listener unavailable — taps fall back to just opening the app
	}

	// --- Phase 2: background poll + sidecar ---
	void configureBackground();
	void drainBackgroundSidecar(); // ingest anything staged while the app was closed
	void seedBackground();

	try {
		await App.addListener('appStateChange', ({ isActive }) => {
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

// ───────────────────────────── foreground notifications ─────────────────────────────

export interface ChatLocalNotification {
	title: string;
	body: string;
	/** Web only: group/favicon icon URL. Native smallIcon is deferred (Phase 4). */
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
		try {
			await LocalNotifications.schedule({
				notifications: [
					{
						id: groupToNotificationId(n.groupId),
						title: n.title || 'Cordn',
						body: n.body,
						// ponytail: smallIcon drawable deferred to Phase 4 (icon pass).
						extra: { groupId: n.groupId }
					}
				]
			});
		} catch {
			// never block chat on a failed notification
		}
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

// ───────────────────────────── background poll + sidecar (Phase 2) ─────────────────────────────

/** Gather the poll set: per group, its coordinator routing + the app's fetchCursor watermark. */
function gatherPollGroups(): PollGroup[] {
	return listChatGroups().map((group) => {
		const coordinator = getChatCoordinator(group.coordinatorKey);
		const relayUrls = coordinator?.relays?.length ? coordinator.relays : defaultRelays;
		return {
			gid: group.id,
			fetchCursor: group.fetchCursor,
			title: group.metadata?.name,
			coordinatorServerPubkey: group.coordinatorKey, // the coordinatorKey *is* the server pubkey
			relayUrls
		};
	});
}

/** Schedule the WorkManager periodic worker. Idempotent. */
export async function configureBackground(): Promise<void> {
	if (!isNativePlatform()) return;
	try {
		await CordnBackground.configure({ pollIntervalMinutes: 15 });
	} catch {
		// plugin unavailable — foreground-only mode
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
