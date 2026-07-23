/**
 * Our canonical public web origin + the "is this us" test for scanned/deep-linked URLs.
 *
 * Inside the native Capacitor shell the WebView is served from `https://localhost` (pinned in
 * capacitor.config.ts to keep the service worker dormant), so anything built from
 * `window.location.origin` embeds an unresolvable localhost host. Every URL that crosses an app
 * boundary — share links/QRs, deep-link routing, signer-app (NIP-46) metadata — must use the
 * canonical origin instead.
 *
 * Keyed off the observable origin (`https://localhost` ⇒ native shell) rather than the platform,
 * so this module carries no native-bridge dependency and works the same on web.
 */

/** The canonical public web origin (the real domain cordn.net is served from). */
export const PUBLIC_WEB_ORIGIN = 'https://cordn.net';

/** The origin the Capacitor WebView is served from inside the native shell. */
const NATIVE_WEBVIEW_ORIGIN = 'https://localhost';

/**
 * The origin to bake into externally-visible URLs (share links/QRs, signer-app metadata). On native
 * (origin is the localhost WebView) this is the canonical web origin; on web it's the real origin
 * (production = cordn.net, dev = the vite preview origin, so local scan-testing still works).
 */
export function publicWebOrigin(): string {
	if (typeof window === 'undefined') return PUBLIC_WEB_ORIGIN;
	return window.location.origin === NATIVE_WEBVIEW_ORIGIN
		? PUBLIC_WEB_ORIGIN
		: window.location.origin;
}

/**
 * Whether an origin refers to this app — used to decide if a scanned/pasted/deep-linked URL routes
 * in-app (goto) instead of opening externally. On native a `cordn.net` link is ours even though
 * `window.location.origin` is `https://localhost`, so both the live origin and the canonical origin
 * count as ours.
 */
export function isAppOrigin(origin: string): boolean {
	if (typeof window === 'undefined') return origin === PUBLIC_WEB_ORIGIN;
	return origin === window.location.origin || origin === PUBLIC_WEB_ORIGIN;
}
