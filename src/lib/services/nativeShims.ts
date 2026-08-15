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
import {
	Camera,
	CameraDirection,
	CameraErrorCode,
	MediaType,
	MediaTypeSelection,
	type MediaResult
} from '@capacitor/camera';

/**
 * Local Capacitor plugin (SaveAsPlugin, in the Android app module) that opens the Storage Access
 * Framework "Save as" picker so the user chooses where a generated file is stored. Native-only; the
 * proxy is inert on web because `saveBlob` only calls it inside an `isNativePlatform()` guard.
 */
interface SaveAsPlugin {
	saveAs(options: {
		data: string;
		/** 'utf8' sends the string as-is; 'base64' (default, legacy) decodes it as base64. */
		encoding?: 'base64' | 'utf8';
		mimeType?: string;
		suggestedName?: string;
	}): Promise<{
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
 * Save text or binary data to a user-chosen filesystem location. Native opens Android's Storage
 * Access Framework "Save as" picker (via the local `SaveAsPlugin`) so the user picks Downloads /
 * Documents / SD card / a cloud provider — the same UX a browser offers for downloads. Web uses
 * `<a download>`.
 *
 * Prefer passing a string when the payload is text (e.g. the JSON backup): it crosses the
 * Capacitor bridge as-is, skipping the Blob → FileReader data-URL → base64 chain that briefly
 * held ~4 extra copies of the payload in the WebView and was the OOM that crashed large native
 * backups. Blobs still take the base64 path (binary callers).
 *
 * Use this for artifacts that must land on the real filesystem — e.g. the encrypted backup. For
 * media, where the system share sheet's Save-to-Photos/Files targets are the expected UX, prefer
 * `shareBlob`. Returns false on a native failure (including the user cancelling the picker).
 */
export async function saveBlob(
	data: Blob | string,
	filename: string,
	mimeType = 'application/json'
): Promise<boolean> {
	if (isNativePlatform()) {
		try {
			if (typeof data === 'string') {
				await SaveAs.saveAs({ data, encoding: 'utf8', mimeType, suggestedName: filename });
			} else {
				await SaveAs.saveAs({
					data: await blobToBase64(data),
					mimeType: data.type || mimeType,
					suggestedName: filename
				});
			}
			return true;
		} catch {
			return false;
		}
	}
	downloadViaAnchor(
		typeof data === 'string' ? new Blob([data], { type: mimeType }) : data,
		filename
	);
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

/**
 * Friendly messages for the structured `CameraErrorCode`s the plugin throws (8.2.0+). Cancel codes
 * are handled separately by `isMediaCancelError` so they stay silent.
 */
const MEDIA_ERROR_MESSAGES: Record<string, string> = {
	[CameraErrorCode.CameraPermissionDenied]: 'Camera permission was denied',
	[CameraErrorCode.GalleryPermissionDenied]: 'Gallery permission was denied',
	[CameraErrorCode.NoCameraAvailable]: 'No camera available on this device'
};

/** True for both the native structured cancel codes and the web path's thrown string. */
function isMediaCancelError(err: unknown): boolean {
	const code = (err as { code?: string })?.code;
	return (
		code === CameraErrorCode.TakePhotoCancelled ||
		code === CameraErrorCode.ChooseMediaCancelled ||
		code === CameraErrorCode.RecordVideoCancelled ||
		/cancel/i.test(String(err))
	);
}

/** Normalize a non-cancel plugin error into an Error whose message is safe to show in a toast. */
function friendlyMediaError(err: unknown): Error {
	const code = (err as { code?: string })?.code;
	const message =
		(code && MEDIA_ERROR_MESSAGES[code]) || (err instanceof Error ? err.message : String(err));
	return new Error(message);
}

/**
 * Convert a Capacitor Camera `MediaResult` into a `File` for the composer's staging pipeline.
 * `webPath` is a blob URL on web and a Capacitor-served file URL on native, so `fetch` works on
 * both — no `Filesystem.readFile` round-trip. Native results carry no original filename (the photo
 * picker returns content:// URIs), so a timestamped name is synthesized.
 */
async function mediaResultToFile(result: MediaResult): Promise<File> {
	if (!result.webPath) throw new Error('Camera returned no media');
	const blob = await fetch(result.webPath).then((response) => response.blob());
	// `result.type` (Photo|Video) is always present and is the reliable signal — `blob.type` from a
	// fetched Capacitor file URL is often empty on native, and `metadata.format` needs includeMetadata.
	// Default per media type; honor metadata.format when present (e.g. png). This is what stops a
	// recorded video from being mislabeled image/jpeg and sent as a broken .jpg.
	const isVideo = result.type === MediaType.Video;
	const format = result.metadata?.format;
	const ext = format ? (format === 'jpeg' ? 'jpg' : format) : isVideo ? 'mp4' : 'jpg';
	const mime = blob.type || (isVideo ? 'video/mp4' : ext === 'png' ? 'image/png' : 'image/jpeg');
	const prefix = isVideo ? 'video' : ext === 'png' ? 'image' : 'photo';
	return new File([blob], `${prefix}-${Date.now()}.${ext}`, {
		type: mime
	});
}

/**
 * Open the camera and capture a single photo. Returns a File ready for the composer's staging
 * pipeline, or null if the user cancelled (silent — not an error). Throws a friendly Error on
 * permission denial / hardware failure so the caller can toast.
 *
 * No `isNativePlatform()` branch: `Camera.takePhoto` opens the native CameraX intent on Android and
 * renders the in-browser `pwa-camera-modal` viewfinder on web (registered from `@ionic/pwa-elements`
 * in the root layout; falls back to a file input if unavailable). The bare `<input capture>` hint is
 * ignored by Capacitor's WebView bridge (ionic-team/capacitor#7411), which is why this routes through
 * the plugin instead of a raw input.
 */
export async function capturePhoto(): Promise<File | null> {
	try {
		const result = await Camera.takePhoto({
			saveToGallery: false,
			correctOrientation: true,
			cameraDirection: CameraDirection.Rear
		});
		return await mediaResultToFile(result);
	} catch (err) {
		if (isMediaCancelError(err)) return null;
		throw friendlyMediaError(err);
	}
}

/**
 * Open the camera and record a video. Native-only: `Camera.recordVideo` is unimplemented on web, so
 * the UI gates this action to native (see ChatComposerActions). Returns a File for the composer's
 * staging pipeline (flows through as a generic 'file' attachment), or null on cancel. `isPersistent:
 * false` keeps the recording in temp cache — the upload copies bytes to the coordinator, so there is
 * no reason to persist locally. Throws a friendly Error on permission / hardware failure.
 */
export async function captureVideo(): Promise<File | null> {
	try {
		const result = await Camera.recordVideo({
			saveToGallery: false,
			isPersistent: false
		});
		return await mediaResultToFile(result);
	} catch (err) {
		if (isMediaCancelError(err)) return null;
		throw friendlyMediaError(err);
	}
}

/**
 * Pick one or more images from the gallery. Native → the modern Android Photo Picker (permissionless
 * on Android 13+, better UX than the legacy ACTION_GET_CONTENT sheet the raw `<input>` landed on);
 * web → a plain `<input type="file" accept="image/*" multiple>` (identical to the previous
 * hand-rolled input, so PWA behavior is unchanged). Image-only; video is a separate decision.
 * Returns [] on cancel.
 */
export async function pickImagesFromGallery(): Promise<File[]> {
	try {
		const { results } = await Camera.chooseFromGallery({
			mediaType: MediaTypeSelection.Photo,
			allowMultipleSelection: true
		});
		return await Promise.all(results.map(mediaResultToFile));
	} catch (err) {
		if (isMediaCancelError(err)) return [];
		throw friendlyMediaError(err);
	}
}
