import { browser } from '$app/environment';
import type { PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Relay } from 'nostr-tools/relay';
import type { Event } from 'nostr-tools';
import { isNativePlatform, openExternal } from '$lib/services/nativeShims';

/**
 * Native (Android) update detection — the counterpart to `appUpdate.svelte.ts`.
 *
 * The web service reloads a new bundle on deploy; native assets are frozen in the
 * APK and update only via a new Zapstore release. So on native we query Zapstore's
 * catalog relay for the latest kind 3063 (SoftwareAsset) signed by Cordn's publisher
 * and compare Android `versionCode` integers — the same rule Zapstore's own updater
 * uses (compare versionCode, never semver strings; missing either side ⇒ no update).
 *
 * v1 is foreground-only (on mount + on resume + 15 min interval). The in-app banner
 * is the signal; a true background check would need a native WorkManager worker.
 */

const ZAPSTORE_RELAY = 'wss://relay.zapstore.dev';
/** Cordn's publishing key — the trust root. Events are author-filtered + sig-verified. */
const CORDN_PUBKEY = 'c3c6d9bb385fd827cfdb45d933a1e8ccf2905be30467151ed5fe356a10a525e9';
const CORDN_APP_ID = 'org.cordn.app';
// Tap target opens Cordn's Zapstore page (resolves by app identifier).
const CORDN_ZAPSTORE_URL = 'https://zapstore.dev/apps/org.cordn.app';

const POLL_INTERVAL_MS = 15 * 60 * 1000;
// Hard cap for a relay that holds the socket without sending EOSE, so the poll
// never hangs (the `inFlight` guard would otherwise block all later checks).
const RELAY_TIMEOUT_MS = 8000;
const DISMISS_KEY = 'cordn-native-update-dismissed-code';

interface ReleaseAsset {
	versionCode: number;
	version: string | null;
}

export const nativeAppUpdateStore = $state<{
	available: boolean;
	latestVersion: string | null;
	latestVersionCode: number | null;
}>({
	available: false,
	latestVersion: null,
	latestVersionCode: null
});

let timer: ReturnType<typeof setInterval> | null = null;
let resumeListener: Promise<PluginListenerHandle> | null = null;
let started = false;
let inFlight = false;

function tagValue(e: Event, name: string): string | null {
	return e.tags.find((t) => t[0] === name)?.[1] ?? null;
}

function getDismissedCode(): number | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(DISMISS_KEY);
		const code = raw ? parseInt(raw, 10) : NaN;
		return Number.isFinite(code) ? code : null;
	} catch {
		return null;
	}
}

/**
 * Fetch the highest-versionCode kind 3063 asset for Cordn. Max (not newest-by-time)
 * because not every published release carries a real versionCode — early ones used a
 * placeholder `1`, and we must never let those shadow a genuine release.
 */
async function fetchLatestRelease(): Promise<ReleaseAsset | null> {
	const relay = await Relay.connect(ZAPSTORE_RELAY);
	try {
		const events: Event[] = [];
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				sub.close();
				resolve();
			};
			const sub = relay.subscribe(
				[{ kinds: [3063], authors: [CORDN_PUBKEY], '#i': [CORDN_APP_ID], limit: 20 }],
				{ onevent: (e) => events.push(e), oneose: finish }
			);
			setTimeout(finish, RELAY_TIMEOUT_MS);
		});

		let best: ReleaseAsset | null = null;
		for (const e of events) {
			const code = parseInt(tagValue(e, 'version_code') ?? '', 10);
			// INVARIANT: missing/invalid versionCode is ignored, never treated as an update.
			if (!Number.isFinite(code) || code <= 0) continue;
			if (best === null || code > best.versionCode) {
				best = { versionCode: code, version: tagValue(e, 'version') };
			}
		}
		return best;
	} finally {
		relay.close();
	}
}

async function getInstalledVersionCode(): Promise<number | null> {
	try {
		// On Android, `build` is versionCode (git commit count — monotonic).
		const code = parseInt((await App.getInfo()).build, 10);
		return Number.isFinite(code) ? code : null;
	} catch {
		return null;
	}
}

async function checkOnce(): Promise<void> {
	if (!browser || inFlight) return;
	inFlight = true;
	try {
		const [installed, latest] = await Promise.all([
			getInstalledVersionCode(),
			fetchLatestRelease()
		]);
		// INVARIANT: either versionCode missing, or not newer ⇒ no update.
		if (installed === null || latest === null || latest.versionCode <= installed) {
			nativeAppUpdateStore.available = false;
			return;
		}
		if (latest.versionCode === getDismissedCode()) {
			nativeAppUpdateStore.available = false;
			return;
		}
		nativeAppUpdateStore.latestVersion = latest.version;
		nativeAppUpdateStore.latestVersionCode = latest.versionCode;
		nativeAppUpdateStore.available = true;
	} catch {
		// relay offline / network error — leave the store as-is; next interval retries.
	} finally {
		inFlight = false;
	}
}

/** Mount once via `NativeAppUpdateBanner.svelte` in the root layout. Native-only no-op on web. */
export function startNativeAppUpdateWatcher(): void {
	if (!browser || !isNativePlatform() || started) return;
	started = true;
	void checkOnce();
	timer = setInterval(checkOnce, POLL_INTERVAL_MS);
	resumeListener = App.addListener('appStateChange', ({ isActive }) => {
		if (isActive) void checkOnce();
	});
}

export function stopNativeAppUpdateWatcher(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	resumeListener?.then((h) => h.remove()).catch(() => {});
	resumeListener = null;
	started = false;
}

/** Dismiss the banner for the current versionCode; it reappears for any newer release. */
export function dismissNativeUpdate(): void {
	const code = nativeAppUpdateStore.latestVersionCode;
	if (code !== null) {
		try {
			localStorage.setItem(DISMISS_KEY, String(code));
		} catch {
			// ignore storage failures
		}
	}
	nativeAppUpdateStore.available = false;
}

/** Open Cordn's Zapstore page so the user can install the new APK. */
export async function openZapstore(): Promise<void> {
	try {
		await openExternal(CORDN_ZAPSTORE_URL);
	} catch {
		// never block on a failed launch
	}
}
