import { CapacitorHttp } from '@capacitor/core';
import { sniffMediaMime } from '$lib/services/mediaSniff';
import { isNativePlatform } from '$lib/services/nativeShims';

const MAX_EMOJI_IMAGE_BYTES = 512 * 1024;
const MAX_EMOJI_IMAGES = 64;
const FETCH_TIMEOUT_MS = 8000;
const SUPPORTED_EMOJI_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Why a pack picture could not be turned into bytes. A browser cannot tell a
 *  CORS block from an offline/DNS failure, so `unreachable` deliberately covers
 *  both — never claim the host is at fault when the browser cannot know. */
export type EmojiImageFailure = 'unreachable' | 'http' | 'timeout' | 'too-large' | 'unsupported';

export class EmojiImageError extends Error {
	constructor(
		message: string,
		readonly reason: EmojiImageFailure,
		readonly status?: number
	) {
		super(message);
		this.name = 'EmojiImageError';
	}
}

/** One sentence a person can read: why this picture is not usable as an emoji. */
export function emojiImageFailureText(error: unknown): string {
	if (!(error instanceof EmojiImageError)) return 'it could not be read';
	switch (error.reason) {
		case 'too-large':
			return 'it is larger than 512 KB';
		case 'unsupported':
			return 'it is not a PNG, JPEG, GIF or WebP';
		case 'timeout':
			return 'its host did not answer in time';
		case 'http':
			return `its host answered ${error.status ?? 'with an error'}`;
		default:
			return 'its host blocked the download or could not be reached';
	}
}

const emojiImageCache = new Map<string, { mime: string; bytes: Uint8Array }>();

/** Native HTTP reads pictures a browser tab cannot (no CORS in a WebView's
 *  native request), which is what makes CORS-less pack hosts sendable on
 *  Android. Same caps and same validation as the web path below. */
async function readNative(url: string): Promise<Uint8Array> {
	try {
		const response = await CapacitorHttp.get({
			url,
			responseType: 'arraybuffer',
			connectTimeout: FETCH_TIMEOUT_MS,
			readTimeout: FETCH_TIMEOUT_MS
		});
		if (response.status < 200 || response.status >= 300) {
			throw new EmojiImageError(`emoji fetch failed: ${response.status}`, 'http', response.status);
		}
		if (typeof response.data !== 'string') {
			throw new EmojiImageError('emoji fetch returned no bytes', 'unreachable');
		}
		return base64ToBytes(response.data);
	} catch (error) {
		if (error instanceof EmojiImageError) throw error;
		const status = (error as { status?: number })?.status;
		throw new EmojiImageError(
			`emoji fetch failed${status ? `: ${status}` : ''}`,
			status ? 'http' : 'unreachable',
			status
		);
	}
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Download and validate a pack picture. The deadline covers the whole body:
 * a host that answers headers and then stalls must not hold the outbox lane.
 */
export async function fetchEmojiImage(url: string): Promise<{ mime: string; bytes: Uint8Array }> {
	const cached = emojiImageCache.get(url);
	if (cached) return cached;
	if (url.startsWith('blob:') || isNativePlatform()) {
		const bytes = url.startsWith('blob:')
			? new Uint8Array(await (await fetch(url)).arrayBuffer())
			: await readNative(url);
		return emojiImage(url, bytes);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let resolveTimeout: (() => void) | undefined;
	const timedOut = new Promise<null>((resolve) => {
		resolveTimeout = () => resolve(null);
	});
	const onAbort = () => resolveTimeout?.();
	controller.signal.addEventListener('abort', onAbort, { once: true });
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

	try {
		let response: Response;
		try {
			response = await fetch(url, {
				referrerPolicy: 'no-referrer',
				signal: controller.signal
			});
		} catch {
			if (controller.signal.aborted) throw timeoutError();
			throw new EmojiImageError('emoji fetch failed', 'unreachable');
		}
		if (!response.ok) {
			throw new EmojiImageError(`emoji fetch failed: ${response.status}`, 'http', response.status);
		}
		const declared = Number(response.headers.get('content-length') ?? '');
		if (Number.isFinite(declared) && declared > MAX_EMOJI_IMAGE_BYTES) {
			throw new EmojiImageError('emoji image is too large', 'too-large');
		}
		reader = response.body?.getReader();
		let bytes: Uint8Array;
		if (reader) {
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const result = await Promise.race([reader.read(), timedOut]);
				if (result === null) throw timeoutError();
				if (result.done) break;
				const value = result.value;
				total += value.byteLength;
				if (total > MAX_EMOJI_IMAGE_BYTES) {
					await reader.cancel().catch(() => {});
					throw new EmojiImageError('emoji image is too large', 'too-large');
				}
				chunks.push(value);
			}
			bytes = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
		} else {
			const buffer = await Promise.race([response.arrayBuffer(), timedOut]);
			if (buffer === null) throw timeoutError();
			bytes = new Uint8Array(buffer);
		}
		return emojiImage(url, bytes);
	} finally {
		controller.signal.removeEventListener('abort', onAbort);
		clearTimeout(timer);
		if (reader) void reader.cancel().catch(() => {});
	}
}

function timeoutError(): EmojiImageError {
	return new EmojiImageError('emoji fetch timed out', 'timeout');
}

/** Validate + memoize the bytes every path above ends with. */
function emojiImage(url: string, bytes: Uint8Array): { mime: string; bytes: Uint8Array } {
	if (bytes.length === 0 || bytes.length > MAX_EMOJI_IMAGE_BYTES) {
		throw new EmojiImageError('emoji image is empty or too large', 'too-large');
	}
	const mime = sniffMediaMime(bytes, false);
	// The four raster types Staircase can decode: anything else would be a tag
	// it cannot draw, so it travels as the shortcode instead.
	if (!mime || !SUPPORTED_EMOJI_MIMES.has(mime)) {
		throw new EmojiImageError('emoji is not a supported image', 'unsupported');
	}
	const image = { mime, bytes };
	if (emojiImageCache.size >= MAX_EMOJI_IMAGES) {
		const oldest = emojiImageCache.keys().next().value;
		if (oldest) emojiImageCache.delete(oldest);
	}
	emojiImageCache.set(url, image);
	return image;
}
