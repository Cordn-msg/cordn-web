import { browser } from '$app/environment';
import { toast } from 'svelte-sonner';
import { isNativePlatform } from '$lib/services/nativeBridge';

/**
 * Update detection.
 *
 * Mirrors the centralized-attention pattern used by `chatAttention.svelte.ts`
 * and `chatReconnectStatus.svelte.ts`: a module-level `$state` store plus a few
 * small functions. The running bundle's version is stamped at build time via
 * Vite `define` (`__APP_VERSION__`, see `vite.config.ts`) and matched against
 * the deployed `static/version.json` (written by `scripts/write-version.mjs`).
 *
 * Detection runs on load and then every 10 minutes. On a mismatch the sticky
 * `AppUpdateBanner` prompts the user to reload. Reload is always manual.
 *
 * A one-shot post-update toast complements the banner: the banner prompts a
 * reload while a tab is open across a deploy, while the toast confirms the
 * update landed after the reload that installed it. Because the service worker
 * serves navigations network-first, a reload often silently picks up the new
 * bundle without the banner ever showing, so the toast is the reliable signal.
 */
const POLL_INTERVAL_MS = 10 * 60 * 1000;
const DISMISS_KEY = 'cordn-app-update-dismissed';
const LAST_SEEN_VERSION_KEY = 'cordn-app-last-seen-version';

const CURRENT_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const CURRENT_SEMVER = typeof __APP_SEMVER__ === 'string' ? __APP_SEMVER__ : '0.0.0';

export const appUpdateStore = $state<{
	available: boolean;
	latestVersion: string | null; // SHA — the comparison key
	latestSemver: string | null; // product version, display only
}>({
	available: false,
	latestVersion: null,
	latestSemver: null
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

function getDismissedVersion(): string | null {
	if (!browser) return null;
	try {
		return sessionStorage.getItem(DISMISS_KEY);
	} catch {
		return null;
	}
}

function getLastSeenVersion(): string | null {
	if (!browser) return null;
	try {
		return localStorage.getItem(LAST_SEEN_VERSION_KEY);
	} catch {
		return null;
	}
}

function setLastSeenVersion(version: string) {
	if (!browser) return;
	try {
		localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
	} catch {
		// ignore storage failures
	}
}

/**
 * Fire one toast on startup when the running version differs from the last one
 * the user saw, then remember the current version. Runs once per page load,
 * production only. Skipped in dev (no real version stamp) without touching
 * storage so a dev session can't trigger a spurious toast on the next prod load.
 */
function notifyAppVersionOnStartup() {
	if (!browser || !import.meta.env.PROD) return;
	const previous = getLastSeenVersion();
	if (previous && previous !== CURRENT_VERSION) {
		toast.success('Cordn updated', { description: `Now running v${CURRENT_SEMVER}` });
	}
	setLastSeenVersion(CURRENT_VERSION);
}

async function pollVersion() {
	if (!browser || pollInFlight) return;
	// Only meaningful for production builds, where the bundle version is stamped
	// and a fresh `version.json` is deployed alongside it.
	if (!import.meta.env.PROD) return;
	pollInFlight = true;
	try {
		const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
		if (!response.ok) return;
		const data = (await response.json()) as { version?: unknown; semver?: unknown };
		const remote = typeof data?.version === 'string' ? data.version : null;
		const remoteSemver = typeof data?.semver === 'string' ? data.semver : null;
		if (!remote || remote === CURRENT_VERSION) {
			appUpdateStore.available = false;
			return;
		}
		if (remote === getDismissedVersion()) {
			appUpdateStore.available = false;
			return;
		}
		appUpdateStore.latestVersion = remote;
		appUpdateStore.latestSemver = remoteSemver;
		appUpdateStore.available = true;
	} catch {
		// network or parse error — ignore; the next interval retries
	} finally {
		pollInFlight = false;
	}
}

/** Start polling. Mount once via `AppUpdateBanner.svelte` in the root layout. */
export function startAppUpdateWatcher() {
	if (!browser) return;
	// One-shot startup toast runs on both platforms — native fires it once after an APK update.
	notifyAppVersionOnStartup();
	// Polling is web-only: native assets are bundled + frozen in the APK, so the served SHA always
	// equals the bundled SHA and the 10-min poll would never fire (the toast above already covers APK updates).
	if (isNativePlatform()) return;
	void pollVersion();
	pollTimer = setInterval(pollVersion, POLL_INTERVAL_MS);
}

export function stopAppUpdateWatcher() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

export function reloadForUpdate() {
	if (browser) location.reload();
}

export function dismissUpdate() {
	if (!browser) return;
	const version = appUpdateStore.latestVersion;
	if (version) {
		try {
			sessionStorage.setItem(DISMISS_KEY, version);
		} catch {
			// ignore storage failures
		}
	}
	appUpdateStore.available = false;
}
