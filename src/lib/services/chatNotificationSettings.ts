import { browser } from '$app/environment';
import { CordnBackground } from 'cordn-background';
import { isNativePlatform } from '$lib/services/nativeShims';

/**
 * Message text in Android notifications. On by default: the decrypted preview
 * is built on-device from a throwaway MLS clone (see chatNotificationPreview),
 * so opting out only hides text — it never changes what is fetched or stored.
 */
export const NOTIFICATION_PREVIEWS_KEY = 'cordn.notificationPreviews';

export function getNotificationPreviewsEnabled(): boolean {
	if (!browser) return true;
	return localStorage.getItem(NOTIFICATION_PREVIEWS_KEY) !== '0';
}

export function setNotificationPreviewsEnabled(enabled: boolean): void {
	if (!browser) return;
	localStorage.setItem(NOTIFICATION_PREVIEWS_KEY, enabled ? '1' : '0');
	if (isNativePlatform()) {
		void CordnBackground.setNotificationPreviews({ enabled }).catch(() => undefined);
	}
}

/** Push the stored choice to the native worker. Called from the native bootstrap. */
export async function applyNotificationPreviewsSetting(): Promise<void> {
	if (!isNativePlatform()) return;
	try {
		await CordnBackground.setNotificationPreviews({ enabled: getNotificationPreviewsEnabled() });
	} catch {
		// Plugin unavailable — the native default (on) still applies.
	}
}
