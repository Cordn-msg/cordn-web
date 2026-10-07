import { CapacitorHttp, registerPlugin } from '@capacitor/core';
import type { QueryFunctionContext } from '@tanstack/svelte-query';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { isNativePlatform } from '$lib/services/nativeShims';

/**
 * GIF search via the gifs.nostr.build public API (https://gifs.nostr.build/developers).
 *
 * Identification is asymmetric by design (their integration guide §1):
 * - Web: the browser's automatic `Origin` header (our registered
 *   `https://cordn.net` origin). NO Authorization header — with an Origin present
 *   it is ignored, it fails the CORS preflight, and a scraped key would spend our
 *   rate quota from anywhere.
 * - Android APK: the WebView origin is `https://localhost` (built-in dev client, not
 *   shippable), so native calls go through CapacitorHttp, which sends no Origin, with
 *   a Bearer key injected at APK build time (gitignored android/gifs.properties →
 *   resValue → GifsApiKeyPlugin).
 */

const API_BASE = 'https://gifs.nostr.build/api/v1';

/** Item fields the picker uses; full schema in the API's OpenAPI. */
export interface GifPreview {
	width: number;
	height: number;
	animated: string | null;
	still: string | null;
}

export interface GifItem {
	id: string;
	/** The original file — the only URL ever inserted into a message. */
	url: string;
	width: number;
	height: number;
	title: string;
	/** data:image/webp;base64 blur placeholder; removed once the preview loads. */
	lqip: string | null;
	previews: {
		small: GifPreview;
		medium: GifPreview;
		w240: GifPreview;
		w480: GifPreview;
	};
}

export class GifSearchUnavailableError extends Error {
	constructor(cause: unknown) {
		super('GIF search unavailable', { cause });
	}
}

export class GifRateLimitedError extends Error {
	constructor() {
		super('GIF search rate limited');
	}
}

/**
 * Trim + pre-validate a picker query. Returns null when nothing should be
 * searched: blank input, or a lone Latin letter (noise that only spends the
 * shared rate budget — a lone emoji/CJK/Hangul character IS a valid search
 * per the API guide §5).
 */
export function normalizeGifQuery(raw: string): string | null {
	const q = raw.trim().slice(0, 100);
	if (!q) return null;
	if (q.length === 1 && /[a-z]/i.test(q)) return null;
	return q;
}

/**
 * Media URLs from this API are always gifs.nostr.build-hosted (guide §4);
 * anything else in a response is treated as invalid, not rendered or posted.
 */
export function isGifsMediaUrl(url: string): boolean {
	return /^https:\/\/gifs\.nostr\.build\//.test(url);
}

interface GifsApiKeyPlugin {
	getKey(): Promise<{ key: string }>;
}

// Native-only: never invoked on web (see requestJson), so the missing native
// registration is inert in the browser bundle.
const GifsApiKey = registerPlugin<GifsApiKeyPlugin>('GifsApiKey');
let nativeKeyValue: string | null = null;

function checkStatus(status: number, data: unknown): unknown {
	if (status === 429) throw new GifRateLimitedError();
	if (status >= 400) throw new Error(`HTTP ${status}`);
	return data;
}

async function requestJson(
	path: string,
	params: Record<string, string>,
	signal?: AbortSignal
): Promise<unknown> {
	const url = `${API_BASE}${path}?${new URLSearchParams(params)}`;
	try {
		if (isNativePlatform()) {
			nativeKeyValue ??= (await GifsApiKey.getKey()).key;
			if (!nativeKeyValue) throw new Error('no provisioned GIF API key');
			const res = await CapacitorHttp.get({
				url,
				headers: { Authorization: `Bearer ${nativeKeyValue}` }
			});
			return checkStatus(res.status, res.data);
		}
		const res = await fetch(url, { signal });
		// 403/503 are answered before CORS headers are added, so they surface
		// here as opaque network errors — the catch below folds them into
		// "unavailable". No point branching on specific statuses in browser code.
		return checkStatus(res.status, await res.json());
	} catch (err) {
		if (err instanceof GifRateLimitedError) throw err;
		// CapacitorHttp rejects non-2xx (unlike fetch) — its error carries the status.
		if ((err as { status?: number })?.status === 429) throw new GifRateLimitedError();
		// Aborts (new query started / picker closed) must pass through untouched.
		if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw err;
		throw new GifSearchUnavailableError(err);
	}
}

export async function searchGifs(query: string, signal?: AbortSignal): Promise<GifItem[]> {
	const data = (await requestJson('/search', { q: query, limit: '40' }, signal)) as {
		items?: GifItem[];
	};
	return Array.isArray(data.items) ? data.items : [];
}

export function gifSearchQueryOptions(query: string | null) {
	return {
		queryKey: chatQueryKeys.gifSearch(query ?? 'idle'),
		queryFn: ({ signal }: QueryFunctionContext) => searchGifs(query ?? '', signal),
		enabled: query !== null,
		// Mirrors the API's Cache-Control: public, max-age=300.
		staleTime: 5 * 60_000,
		refetchOnWindowFocus: false,
		// 429 → never retry (server asks for a minute of quiet); transient
		// unavailability (503/network) gets one retry.
		retry: (failureCount: number, error: unknown) =>
			error instanceof GifRateLimitedError ? false : failureCount < 1
	};
}
