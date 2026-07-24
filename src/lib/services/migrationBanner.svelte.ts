/**
 * New-device migration banner: a friendly, dismissible reminder shown when the active account has a
 * key package published by another device (the "you've used Cordn before" signal) but this device
 * holds none locally and has no groups yet. Guides the user to link devices or restore a backup.
 * Take-over (the destructive "publish from here instead" path) is intentionally NOT offered here —
 * it stays in LastResortConflictDialog / the key-packages page, where its warning belongs.
 *
 * Visibility is derived in the component from: `detected` (set by the probe) AND no local groups AND
 * multi-device not active AND not dismissed for this account. The dismiss map is a reactive $state
 * (persisted to localStorage) so the banner hides the instant the user clicks X; `detected`
 * self-clears when the user links or restores (groups arrive), so dismissal is just the manual override.
 */
import { browser } from '$app/environment';
import { manager } from '$lib/services/accountManager.svelte';
import { normalizePubKey } from '$lib/utils';
import { listKnownCoordinatorKeys } from '$lib/services/chatCoordinators.svelte';
import { detectForeignKeyPackage } from '$lib/services/chatKeyPackages.svelte';
import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';

const DISMISS_KEY = 'cordn.migrationDismissed';

function loadDismissed(): Record<string, boolean> {
	if (!browser) return {};
	try {
		const parsed = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '{}');
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

export const migrationBannerStore = $state<{
	detected: boolean;
	dismissed: Record<string, boolean>;
}>({
	detected: false,
	// Hydrated from localStorage at module load (guarded for SSR); mutated reactively on dismiss.
	dismissed: loadDismissed()
});

/** Last (account + coordinator-set) we probed, so the check runs once per login / coordinator add. */
let lastFingerprint = '';

export function isMigrationDismissed(pubkey?: string): boolean {
	if (!pubkey) return false;
	return Boolean(migrationBannerStore.dismissed[normalizePubKey(pubkey)]);
}

export function dismissMigrationBanner(): void {
	if (!browser) return;
	const pk = manager.getActive()?.pubkey;
	if (!pk) return;
	// Mutate the reactive map so the banner's $derived visibility re-evaluates immediately, then
	// persist so the dismissal survives reloads.
	migrationBannerStore.dismissed[normalizePubKey(pk)] = true;
	localStorage.setItem(DISMISS_KEY, JSON.stringify(migrationBannerStore.dismissed));
}

/**
 * Probe known coordinators (default + user-added) for a foreign key package and set `detected`.
 * Idempotent per (account, coordinator-set) fingerprint, so it runs once per login / coordinator add,
 * not on every reactive tick. Read-only — never publishes. Fires from the MigrationBanner $effect.
 */
export async function checkMigrationBanner(): Promise<void> {
	if (!browser) return;
	const pk = manager.getActive()?.pubkey;
	if (!pk) {
		migrationBannerStore.detected = false;
		lastFingerprint = '';
		return;
	}
	const coordinators = [
		DEFAULT_CHAT_COORDINATOR_PUBKEY,
		...listKnownCoordinatorKeys().map(normalizePubKey)
	];
	const uniqueCoordinators = [...new Set(coordinators)];
	const fingerprint = `${normalizePubKey(pk)}|${uniqueCoordinators.sort().join(',')}`;
	if (fingerprint === lastFingerprint) return;
	lastFingerprint = fingerprint;

	// Reset across accounts before the await so a stale value from the previous identity never flashes.
	migrationBannerStore.detected = false;
	const results = await Promise.all(
		uniqueCoordinators.map((c) => detectForeignKeyPackage(c).catch(() => false))
	);
	// Bail if the account changed mid-probe; the new account's check is already in flight.
	if (manager.getActive()?.pubkey !== pk) return;
	migrationBannerStore.detected = results.some(Boolean);
}
