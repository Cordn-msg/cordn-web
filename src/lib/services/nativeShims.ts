/**
 * Leaf seam for web-platform APIs the Capacitor WebView does not honor: the `<a download>`
 * attribute, `navigator.clipboard`, and `window.open` / external links. Each function branches on
 * `isNativePlatform()` and delegates to a Capacitor plugin on native (first-party, or the local
 * `SaveAsPlugin` for save-to-files); web behavior is unchanged.
 *
 * Lives in its own leaf module (not `nativeBridge.ts`) so that `utils.ts` — imported across the
 * whole app — can use these without pulling in nativeBridge's heavy graph (account manager, chat
 * services, background worker). `nativeBridge.ts` re-exports `isNativePlatform` from here.
 */
import { browser } from '$app/environment';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Clipboard } from '@capacitor/clipboard';

/**
 * Local Capacitor plugin (SaveAsPlugin, in the Android app module) that opens the Storage Access
 * Framework "Save as" picker so the user chooses where a generated file is stored. Native-only; the
 * proxy is inert on web because `saveBlob` only calls it inside an `isNativePlatform()` guard.
 */
interface SaveAsPlugin {
	saveAs(options: { data: string; mimeType?: string; suggestedName?: string }): Promise<{
		uri: string;
	}>;
}
const SaveAs = registerPlugin<SaveAsPlugin>('SaveAs');

/** True only inside the Capacitor native shell (Android). Web/PWA → false. */
export function isNativePlatform(): boolean {
	return browser && Capacitor.isNativePlatform();
}

/**
 * Open a URL outside the app. Native → system browser via the Browser plugin (a Custom Tab); web →
 * a new tab. Inside the WebView, `window.open(_, '_blank')` and `<a target="_blank">` either no-op
 * or navigate the SPA onto the external site, trapping the user off-app.
 */
export async function openExternal(url: string): Promise<void> {
	if (isNativePlatform()) {
		await Browser.open({ url });
		return;
	}
	window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Svelte action for external `<a href target="_blank">`: on native, intercept the click and hand it
 * to the Browser plugin so the link opens in the system browser instead of the in-app WebView.
 * No-op on web (the anchor's default navigation is correct there).
 */
export function externalLink(node: HTMLAnchorElement): { destroy: () => void } {
	function onClick(e: MouseEvent): void {
		if (!isNativePlatform()) return;
		const href = node.getAttribute('href');
		if (!href) return;
		e.preventDefault();
		// Delegate to openExternal (Browser plugin); if it unexpectedly throws, fall back to the web
		// path so the click still opens the link instead of being silently dropped (default nav is gone).
		void openExternal(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
	}
	node.addEventListener('click', onClick);
	return { destroy: () => node.removeEventListener('click', onClick) };
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			const result = reader.result as string;
			// readAsDataURL returns "data:*/*;base64,XXXX"; the Capacitor plugins want bare base64.
			const comma = result.indexOf(',');
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

/**
 * Web fallback shared by `saveBlob` and `shareBlob`: synthesize an `<a download>` click, which the
 * real browser honors (the WebView ignores it, which is why the native branches exist).
 */
function downloadViaAnchor(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/**
 * Save a blob to a user-chosen filesystem location. Native opens Android's Storage Access Framework
 * "Save as" picker (via the local `SaveAsPlugin`) so the user picks Downloads / Documents / SD card
 * / a cloud provider — the same UX a browser offers for downloads. Web uses `<a download>`.
 *
 * Use this for artifacts that must land on the real filesystem — e.g. the encrypted backup. For
 * media, where the system share sheet's Save-to-Photos/Files targets are the expected UX, prefer
 * `shareBlob`. Returns false on a native failure (including the user cancelling the picker).
 */
export async function saveBlob(blob: Blob, filename: string): Promise<boolean> {
	if (isNativePlatform()) {
		try {
			await SaveAs.saveAs({
				data: await blobToBase64(blob),
				mimeType: blob.type || 'application/octet-stream',
				suggestedName: filename
			});
			return true;
		} catch {
			return false;
		}
	}
	downloadViaAnchor(blob, filename);
	return true;
}

/**
 * Offer a blob via the system share sheet (Save to Files / Photos / Drive / email). Native stages
 * the blob to the app cache and shares the file URI; web uses `<a download>`. Use for media, where
 * the share sheet's handlers are the expected UX (on a real device it offers Save-to-Photos/Files;
 * the test emulator only exposes Gmail/Drive). Returns false if native staging/share throws.
 */
export async function shareBlob(blob: Blob, filename: string): Promise<boolean> {
	if (isNativePlatform()) {
		try {
			const base64 = await blobToBase64(blob);
			const { uri } = await Filesystem.writeFile({
				path: filename,
				data: base64,
				directory: Directory.Cache,
				recursive: true
			});
			await Share.share({ files: [uri] });
			return true;
		} catch {
			return false;
		}
	}
	downloadViaAnchor(blob, filename);
	return true;
}

/**
 * Copy text to the clipboard. Native → the Clipboard plugin; web → `navigator.clipboard`.
 * `navigator.clipboard` is flaky in the Android WebView (strict focus/gesture rules) and its image
 * variant (`ClipboardItem`) effectively never works there, so the plugin is the reliable path.
 */
export async function copyText(text: string): Promise<void> {
	if (isNativePlatform()) {
		await Clipboard.write({ string: text });
		return;
	}
	await navigator.clipboard.writeText(text);
}
