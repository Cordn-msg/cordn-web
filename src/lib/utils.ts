import { browser } from '$app/environment';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { toast } from 'svelte-sonner';
import { isHex } from 'applesauce-core/helpers';
import { copyText, shareBlob } from '$lib/services/nativeShims';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

export function formatUnixTimestamp(
	timestamp: number,
	showTime?: boolean,
	showDate: boolean = true,
	locale?: string
): string {
	const date = new Date(timestamp);
	const options: Intl.DateTimeFormatOptions = {};

	if (showDate) {
		options.dateStyle = 'medium';
	}

	if (showTime) {
		options.timeStyle = 'short';
	}

	return date.toLocaleString(locale, options);
}

/**
 * Generate a hex color from a hexadecimal string pubkey
 * Takes the first 6 characters and prepends '#' to create a valid hex color
 */
export function pubkeyToHexColor(pubkey: string): string {
	if (!pubkey) {
		throw new Error('Pubkey is required');
	}

	const hexColor = pubkey.slice(0, 6);

	return `#${hexColor}`;
}

/**
 * Copy text to clipboard. Delegates to `copyText` so it works inside the Capacitor WebView
 * (where `navigator.clipboard` is unreliable), then toasts success/failure.
 */
export async function copyToClipboard(text: string) {
	try {
		await copyText(text);
		toast.success('Copied 👍');
	} catch (e) {
		toast.error(`Error: ${e}`);
		console.log(e);
	}
}

/**
 * Slugify a string
 */
export function slugify(text: string): string {
	return text
		.toString() // Convert to string (just in case)
		.toLowerCase() // Lowercase all characters
		.trim() // Remove leading/trailing spaces
		.normalize('NFD') // Normalize the string to decompose accented characters
		.replace(/[\u0300-\u036f]/g, '') // Remove all combining diacritical marks
		.replace(/[^a-z0-9\s-]/g, '') // Remove all non-word characters (allows letters, numbers, spaces, dashes)
		.replace(/[\s-]+/g, '-') // Replace spaces and dashes with a single dash
		.replace(/^-+|-+$/g, ''); // Trim dashes from the beginning and the end
}

export function buildUniqueSlugId(
	existingIds: Iterable<string>,
	label: string,
	fallback: string
): string {
	const baseId = slugify(label) || fallback;
	const ids = new Set(existingIds);
	let id = baseId;
	let suffix = 2;
	while (ids.has(id)) {
		id = `${baseId}-${suffix++}`;
	}
	return id;
}

export function areStringArraysEqual(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function normalizePubKey(pubkey: string): string {
	const normalized = pubkey.trim().toLowerCase();
	if (!isHex(normalized)) {
		throw new Error('Coordinator pubkey must be a 64-character hex string');
	}
	return normalized;
}

/**
 * Case-insensitive pubkey equality without normalizePubKey's hex-validation throw, so a
 * malformed/foreign sender can't crash a comparison. Both operands are expected to be hex
 * pubkeys (the only form stored in chat state); this only removes case/whitespace variance —
 * the self-message notify filter uses it so a signer that returns a differently-cased pubkey
 * can't let an own message through a raw ===.
 */
export function samePubKey(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Trigger a download of a (blob/object/remote) URL under the given filename. Web synthesizes an
 * `<a download>` click via `saveBlob`; native fetches the blob and hands it to the share sheet (the
 * WebView ignores the download attribute). Best-effort: fetch/save failures are swallowed. No-op on
 * the server. Shared by the media views (chat bubble, lightbox, message actions).
 */
export async function downloadObjectUrl(url: string, filename: string): Promise<void> {
	if (!browser) return;
	try {
		const blob = await (await fetch(url)).blob();
		await shareBlob(blob, filename);
	} catch {
		// best-effort download trigger; a failed fetch/save is non-fatal
	}
}

// ponytail: extension sniff on the path (query/hash stripped). Good enough for
// pasted links; a real content-type would need a network HEAD, which defeats
// the lazy auto-load gate. Add MIME sniffing if naive extension misses real
// servers that serve media without an extension.
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const VIDEO_URL_RE = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i;
export function mediaUrlKind(href: string): 'image' | 'video' | null {
	const path = href.split('?')[0]?.split('#')[0] ?? href;
	if (IMAGE_URL_RE.test(path)) return 'image';
	if (VIDEO_URL_RE.test(path)) return 'video';
	return null;
}

/** Short, user-facing label for a media item's type — file extension when the
 *  name carries one, else the MIME subtype, else empty. Shown on "Load media"
 *  buttons so the user knows what they'd fetch before committing. */
export function mediaExtLabel(filename?: string, mime?: string): string {
	if (filename) {
		const dot = filename.lastIndexOf('.');
		if (dot > 0) {
			const ext = filename.slice(dot + 1);
			if (ext.length > 1 && ext.length <= 5) return ext.toUpperCase();
		}
	}
	if (mime && mime.includes('/')) return mime.split('/').pop()!.toUpperCase();
	return '';
}
