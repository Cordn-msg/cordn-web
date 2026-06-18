import { browser } from '$app/environment';

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
 */
const POLL_INTERVAL_MS = 10 * 60 * 1000;
const DISMISS_KEY = 'cordn-app-update-dismissed';

const CURRENT_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export const appUpdateStore = $state<{ available: boolean; latestVersion: string | null }>({
	available: false,
	latestVersion: null
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

async function pollVersion() {
	if (!browser || pollInFlight) return;
	// Only meaningful for production builds, where the bundle version is stamped
	// and a fresh `version.json` is deployed alongside it.
	if (!import.meta.env.PROD) return;
	pollInFlight = true;
	try {
		const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
		if (!response.ok) return;
		const data = (await response.json()) as { version?: unknown };
		const remote = typeof data?.version === 'string' ? data.version : null;
		if (!remote || remote === CURRENT_VERSION) {
			appUpdateStore.available = false;
			return;
		}
		if (remote === getDismissedVersion()) {
			appUpdateStore.available = false;
			return;
		}
		appUpdateStore.latestVersion = remote;
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
