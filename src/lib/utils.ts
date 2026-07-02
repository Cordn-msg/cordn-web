import { browser } from '$app/environment';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { toast } from 'svelte-sonner';
import { isHex } from 'applesauce-core/helpers';

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
 * Copy data to clipboard
 */
export async function copyToClipboard(data: BlobPart, mimeType = 'text/plain') {
	try {
		// Always use text/plain for maximum compatibility
		const textData = String(data);

		if (navigator.clipboard.write) {
			await navigator.clipboard.write([
				new ClipboardItem({
					[mimeType]: new Blob([textData], {
						type: mimeType
					}),
					['text/plain']: new Blob([textData], {
						type: 'text/plain'
					})
				})
			]);
		} else {
			await new Promise((resolve) => {
				resolve(navigator.clipboard.writeText(textData));
			});
		}
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
 * Trigger a browser download of a (blob/object) URL under the given filename.
 * Browser-only; no-op on the server. Shared by the media views (chat bubble,
 * lightbox, message actions) so each isn't synthesizing its own <a>.
 */
export function downloadObjectUrl(url: string, filename: string): void {
	if (!browser) return;
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
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
