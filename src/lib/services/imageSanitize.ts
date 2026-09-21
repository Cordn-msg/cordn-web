import { isHeicMime, mediaExtFromMime, replaceFileExt } from './mediaSniff';
import { isNativePlatform, nativeImageToJpeg } from './nativeShims';

/**
 * Strips EXIF/metadata from an image file before it is staged (and later
 * encrypted + uploaded): decoding to pixels and re-encoding produces a fresh
 * file with no capture location, device model, or timestamps, and orientation
 * baked into the pixels. For a privacy-first messenger the encrypted blob
 * should carry pixels, not identity — it outlives group membership on
 * content-addressed stores (spec §8: prior disclosure).
 *
 * Runs at staging, so the composer preview shows the exact bytes that will be
 * encrypted — WYSIWYG privacy. Sender-side by necessity: the spec binds
 * mime/filename/x to the exact plaintext, so nothing can change after send.
 *
 * - HEIC/HEIF on native: the WebView cannot decode HEIC (no HEVC image support
 *   in Chromium), so the SanitizeImage Java plugin transcodes with the platform
 *   decoder (API 28+). On web, Safari's canvas can decode HEIC natively and the
 *   same re-encode applies; Chromium falls through to the original file.
 * - Everything else: createImageBitmap + canvas re-encode (PNG stays PNG —
 *   lossless and alpha-safe; JPEG/WebP at q0.9). GIF is skipped: canvas keeps
 *   only the first frame of an animation.
 *   ponytail: an animated WebP/AVIF is also flattened to its first frame here.
 *   Galleries don't produce those, so it's documented, not handled; move the
 *   mime to SKIP_SANITIZE if it ever matters.
 * - Any failure returns the original file unchanged (labels stay truthful —
 *   mediaResultToFile sniffed them): a sendable image beats a blocked send.
 */

// ponytail: runs on the main thread — decode is browser-threaded internally and
// toBlob encodes async, so the one-shot staging flow doesn't jank. If big
// photo batches ever visibly stutter, lift this into a one-shot worker the way
// runMediaWorker does it (the File→File seam makes that a mechanical move).
const SKIP_SANITIZE = new Set(['image/gif', 'image/svg+xml']);

const KEEP_TYPE = new Set(['image/png', 'image/webp']);

export async function sanitizeImageFile(file: File): Promise<File> {
	const mime = file.type;
	if (!mime.startsWith('image/') || SKIP_SANITIZE.has(mime)) return file;

	if (isHeicMime(mime) && isNativePlatform()) {
		return (await nativeImageToJpeg(file)) ?? file;
	}

	try {
		const bitmap = await createImageBitmap(file);
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
		bitmap.close();
		const type = KEEP_TYPE.has(mime) ? mime : 'image/jpeg';
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, type, type === 'image/jpeg' ? 0.9 : undefined)
		);
		if (!blob) return file;
		return new File([blob], replaceFileExt(file.name, mediaExtFromMime(type)), { type });
	} catch {
		return file;
	}
}
