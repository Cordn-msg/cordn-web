import { sniffMediaMime } from '$lib/services/mediaSniff';

const MAX_EMOJI_IMAGE_BYTES = 512 * 1024;
const MAX_EMOJI_IMAGES = 64;
const FETCH_TIMEOUT_MS = 8000;
const SUPPORTED_EMOJI_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const emojiImageCache = new Map<string, { mime: string; bytes: Uint8Array }>();

/**
 * Download and validate a pack picture. The deadline covers the whole body:
 * a host that answers headers and then stalls must not hold the outbox lane.
 */
export async function fetchEmojiImage(url: string): Promise<{ mime: string; bytes: Uint8Array }> {
	const cached = emojiImageCache.get(url);
	if (cached) return cached;

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
		} catch (error) {
			if (controller.signal.aborted) throw new Error('emoji fetch timed out', { cause: error });
			throw error;
		}
		if (!response.ok) throw new Error(`emoji fetch failed: ${response.status}`);
		const declared = Number(response.headers.get('content-length') ?? '');
		if (Number.isFinite(declared) && declared > MAX_EMOJI_IMAGE_BYTES) {
			throw new Error('emoji image is too large');
		}
		reader = response.body?.getReader();
		let bytes: Uint8Array;
		if (reader) {
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const result = await Promise.race([reader.read(), timedOut]);
				if (result === null) throw new Error('emoji fetch timed out');
				if (result.done) break;
				const value = result.value;
				total += value.byteLength;
				if (total > MAX_EMOJI_IMAGE_BYTES) {
					await reader.cancel().catch(() => {});
					throw new Error('emoji image is too large');
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
			if (buffer === null) throw new Error('emoji fetch timed out');
			bytes = new Uint8Array(buffer);
		}
		if (bytes.length === 0 || bytes.length > MAX_EMOJI_IMAGE_BYTES) {
			throw new Error('emoji image is empty or too large');
		}
		const mime = sniffMediaMime(bytes, false);
		// The four raster types Staircase can decode: anything else would be a tag
		// it cannot draw, so it travels as the shortcode instead.
		if (!mime || !SUPPORTED_EMOJI_MIMES.has(mime)) {
			throw new Error('emoji is not a supported image');
		}
		const image = { mime, bytes };
		if (emojiImageCache.size >= MAX_EMOJI_IMAGES) {
			const oldest = emojiImageCache.keys().next().value;
			if (oldest) emojiImageCache.delete(oldest);
		}
		emojiImageCache.set(url, image);
		return image;
	} finally {
		controller.signal.removeEventListener('abort', onAbort);
		clearTimeout(timer);
		if (reader) void reader.cancel().catch(() => {});
	}
}
