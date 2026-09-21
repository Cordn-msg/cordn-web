/**
 * Magic-byte sniffing for media files (spec: ISOBMFF `ftyp` brands are
 * definitive; MIME guesses are not). Used where labels are fabricated —
 * `nativeShims.mediaResultToFile` on native, where `blob.type` from a fetched
 * Capacitor file URL is often empty. A truthful label is load-bearing: the
 * encrypted-media spec binds `m`/`x`/`filename` into the AEAD AAD (§3.2), so a
 * wrong label is unfixable after send — and a HEIC mislabeled `image/jpeg`
 * renders as a silent blank (Chromium cannot decode HEIC at all).
 */

const tag = (bytes: Uint8Array, offset: number, length: number): string =>
	String.fromCharCode(...bytes.subarray(offset, offset + length));

/** Sniff a media MIME type from the leading magic bytes, or null if unknown.
 *  `isVideo` is the picker's Photo/Video signal: it disambiguates ISOBMFF
 *  brands the map doesn't name (isom/mp41/avc1… → video, not a mystery). */
export function sniffMediaMime(bytes: Uint8Array, isVideo: boolean): string | null {
	if (bytes.length < 12) return null;
	// ISOBMFF containers (JPEG-family photos + MP4 + HEIC/HEIF/AVIF): size(4) 'ftyp' brand(4).
	if (tag(bytes, 4, 4) === 'ftyp') {
		switch (tag(bytes, 8, 4)) {
			case 'heic':
			case 'heix':
			case 'hevc':
			case 'hevx':
				return 'image/heic';
			case 'mif1':
			case 'msf1':
			case 'heif':
				return 'image/heif';
			case 'avif':
			case 'avis':
				return 'image/avif';
			default:
				return isVideo ? 'video/mp4' : null;
		}
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes[0] === 0x89 && tag(bytes, 1, 3) === 'PNG') return 'image/png';
	if (tag(bytes, 0, 4) === 'GIF8') return 'image/gif';
	if (tag(bytes, 0, 4) === 'RIFF' && tag(bytes, 8, 4) === 'WEBP') return 'image/webp';
	// EBML (Matroska/WebM).
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
		return 'video/webm';
	}
	return null;
}

/** HEIC/HEIF stills — the formats the WebView cannot decode (Android native
 *  transcodes them via the platform decoder; see imageSanitize.ts). */
export function isHeicMime(mime: string): boolean {
	return mime === 'image/heic' || mime === 'image/heif';
}

const MEDIA_EXTS: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/heic': 'heic',
	'image/heif': 'heif',
	'image/avif': 'avif',
	'video/mp4': 'mp4',
	'video/webm': 'webm'
};

/** Common extension for a sniffed media MIME ('bin' for anything else). */
export function mediaExtFromMime(mime: string): string {
	return MEDIA_EXTS[mime] ?? 'bin';
}

/** Swap (or append) a file extension — `IMG_1234.HEIC` + 'jpg' → `IMG_1234.jpg`. */
export function replaceFileExt(name: string, ext: string): string {
	const stem = name.replace(/\.[^.]*$/, '');
	return `${stem}.${ext}`;
}
