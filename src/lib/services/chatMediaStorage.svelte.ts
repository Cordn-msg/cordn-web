import { browser } from '$app/environment';
import { SvelteSet } from 'svelte/reactivity';

import { bytesToHex, hexToBytes } from 'applesauce-core/helpers';
import { base64ToBytes, bytesToBase64 } from 'ts-mls';

import { DEFAULT_BLOSSOM_SERVER, BLOSSOM_SERVERS } from '$lib/constants/chat';
import {
	BlossomUploadError,
	ephemeralBlossomSigner,
	fetchBlob,
	uploadBlob,
	verifyBlobRoundtrip,
	type BlossomSigner
} from '$lib/services/chatBlossomClient';
import {
	buildImetaTag,
	buildMediaTag,
	deriveMediaKey,
	encryptMedia,
	findImetaTag,
	isKnownMediaVersion,
	MEDIA_VERSION,
	type MediaMetadata,
	type MediaReference,
	type MediaDecryptRequest,
	type MediaWorkerResponse
} from '$lib/services/chatMediaCrypto';
import { EMOJI_MEDIA_TAG } from '$lib/chat/emoji';
import { emojiSourcesForContent } from '$lib/services/chatEmojiPacks.svelte';
import { mediaExtFromMime, sniffMediaMime } from '$lib/services/mediaSniff';
import {
	decodeStoredGroupState,
	getChatGroup,
	sendChatGroupMessage
} from '$lib/services/chatGroups.svelte';
import { requireActiveAccount } from '$lib/services/chatRuntime';
import type { ChatMessageReplyTarget } from '$lib/chat/references';

/**
 * Encrypted-media orchestration: ties the `cordn-em-v1` crypto layer to Blossom
 * upload/fetch and the existing group-message send path. Owns the user's chosen
 * Blossom server (config) and a small decrypted-media ObjectURL cache for the
 * receive side.
 *
 * The upload runs OUTSIDE the per-group operation lock (acquired only inside
 * sendChatGroupMessage), so the composer stays free for the next message while
 * a media blob uploads. Media *decryption* currently runs on the main thread;
 * moving it to a worker is a drop-in optimization (the cipher op in
 * chatMediaCrypto is pure/worker-safe).
 */

const SERVER_STORAGE_KEY = 'cordn.blossomServer';

function normalizeServerUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) return DEFAULT_BLOSSOM_SERVER;
	return trimmed.replace(/\/+$/, '') + '/';
}

function loadBlossomServer(): string {
	if (!browser) return DEFAULT_BLOSSOM_SERVER;
	return normalizeServerUrl(localStorage.getItem(SERVER_STORAGE_KEY) ?? DEFAULT_BLOSSOM_SERVER);
}

let blossomServer = $state(loadBlossomServer());

export function getBlossomServer(): string {
	return blossomServer;
}

export function setBlossomServer(url: string): void {
	blossomServer = normalizeServerUrl(url);
	if (browser) localStorage.setItem(SERVER_STORAGE_KEY, blossomServer);
}

export function isCustomBlossomServer(): boolean {
	return !BLOSSOM_SERVERS_PRESET.has(getBlossomServer());
}

// Display preferences — booleans persisted as '1'/'0'. Both default ON so media
// just works; turning auto-load off shows a per-item "Load media" gate instead
// of fetching/decrypting every attachment (bandwidth + privacy on metered links).
const MEDIA_AUTOLOAD_KEY = 'cordn.mediaAutoLoad';
const LOAD_AVATARS_KEY = 'cordn.loadAvatars';

function loadBoolSetting(key: string, fallback: boolean): boolean {
	if (!browser) return fallback;
	const v = localStorage.getItem(key);
	return v === null ? fallback : v === '1';
}

let mediaAutoLoad = $state(loadBoolSetting(MEDIA_AUTOLOAD_KEY, true));
let loadAvatars = $state(loadBoolSetting(LOAD_AVATARS_KEY, true));

export function getMediaAutoLoad(): boolean {
	return mediaAutoLoad;
}
export function setMediaAutoLoad(value: boolean): void {
	mediaAutoLoad = value;
	if (browser) localStorage.setItem(MEDIA_AUTOLOAD_KEY, value ? '1' : '0');
}
export function getLoadAvatars(): boolean {
	return loadAvatars;
}
export function setLoadAvatars(value: boolean): void {
	loadAvatars = value;
	if (browser) localStorage.setItem(LOAD_AVATARS_KEY, value ? '1' : '0');
}

// Per-item "Load media" overrides for when global auto-load is OFF. Hoisted to
// module scope so they survive virtualized-row remounts — InlineMediaUrl's local
// state was lost on a remount (the load-button flicker), and the same latent loss
// applies to imeta attachments on scroll-away-and-back. Keyed by URL for pasted
// inline media, by messageId for encrypted imeta attachments. Session-scoped and
// unbounded; cap if it ever matters.
const revealedMediaUrls = new SvelteSet<string>();
export function isMediaUrlRevealed(href: string): boolean {
	return revealedMediaUrls.has(href);
}
export function revealMediaUrl(href: string): void {
	revealedMediaUrls.add(href);
}

const loadedMessageMedia = new SvelteSet<string>();
export function isMessageMediaLoaded(messageId: string): boolean {
	return loadedMessageMedia.has(messageId);
}
export function markMessageMediaLoaded(messageId: string): void {
	loadedMessageMedia.add(messageId);
}

// Resolve failures are remembered per plaintext hash (the cache key) so a
// permanently dead blob link — old sends whose store object is gone — settles
// on the error card instead of re-fetching on every row remount or
// messages-array identity churn (the spinner/error blink loop). Session-scoped
// like the reveal overrides above; cleared only by an explicit retry tap.
const failedMessageMedia = new SvelteSet<string>();
export function isMessageMediaFailed(plaintextHashHex: string): boolean {
	return failedMessageMedia.has(plaintextHashHex);
}
export function markMessageMediaFailed(plaintextHashHex: string): void {
	failedMessageMedia.add(plaintextHashHex);
}
export function clearMessageMediaFailure(plaintextHashHex: string): void {
	failedMessageMedia.delete(plaintextHashHex);
}

const BLOSSOM_SERVERS_PRESET = new Set<string>(
	// Set for O(1) preset membership so the config UI can show "Custom" when the
	// user typed a URL not in BLOSSOM_SERVERS.
	[...BLOSSOM_SERVERS]
);

//
// In-flight upload cancellation registry
//
// Keyed by optimistic message id (the id the uploading message renders with).
// `sendOneMedia` registers/unregisters around the send; the uploading message's
// cancel button calls `cancelMediaUpload(id)`. ponytail: a plain object, not a
// SvelteMap — this is a non-reactive imperative registry of controllers, not
// UI state (mirrors `mediaObjectUrlCache` below). The svelte/reactivity rule
// flags Map in .svelte.ts; a Record dodges it. Button visibility is driven by
// the message's `uploading` field, so this just holds the AbortController so
// the leaf render component can reach the in-flight request without
// prop-drilling through the message list. Entries are removed in a `finally`,
// so the map never leaks across settled sends.
const mediaUploadControllers: Record<string, AbortController> = {};

export function registerMediaUpload(id: string, controller: AbortController): void {
	mediaUploadControllers[id] = controller;
}

export function unregisterMediaUpload(id: string): void {
	delete mediaUploadControllers[id];
}

export function cancelMediaUpload(id: string): void {
	mediaUploadControllers[id]?.abort();
}

//
// In-flight upload progress — reactive, keyed by optimistic message id.
//
// Lives OUTSIDE the message object on purpose: `xhr.upload.onprogress` fires
// 10–20×/sec, and routing each tick through the message list (array rebuild +
// sort + virtualizer remeasure) was the source of the upload flicker. The
// uploading bubble reads this record directly, so a tick invalidates only that
// one component. `percent: null` = indeterminate (connecting / finalizing /
// retrying); `phase` is the caption shown under it. `reportMediaUpload`
// coalesces sub-100% ticks to ~10/sec — the bar already animates via
// `transition-[width] duration-200`, so finer granularity is wasted renders.
export const mediaUploadProgress = $state<
	Record<string, { percent: number | null; phase?: string }>
>({});
const lastProgressReport = new Map<string, number>();
const PROGRESS_THROTTLE_MS = 100;

export function reportMediaUpload(id: string, percent: number | null, phase?: string): void {
	const now = performance.now();
	const last = lastProgressReport.get(id);
	if (
		last !== undefined &&
		percent !== null &&
		percent !== 100 &&
		now - last < PROGRESS_THROTTLE_MS
	) {
		return;
	}
	lastProgressReport.set(id, now);
	mediaUploadProgress[id] = { percent, phase };
}

export function clearMediaUploadProgress(id: string): void {
	lastProgressReport.delete(id);
	delete mediaUploadProgress[id];
}

//
// Per-server byte-fidelity verdict for the upload fallback loop (session-scoped).
//
// The blob is opaque AEAD `application/octet-stream`, so a server either
// stores uploads verbatim or re-encodes them — a property of the server, not
// the file. Once a server passes `verifyBlobRoundtrip` it always will; once it
// serves mismatched bytes it always will. Memoizing both means: after the first
// upload learns the verdict, subsequent sends SKIP the wasted PUT+GET to a
// re-encoding server and SKIP the verify GET on a faithful one. Session-scoped
// (clears on reload) so a server config change is eventually re-detected.
const blobServerVerdict = new Map<string, 'good' | 'bad'>();

/**
 * Upload to the configured Blossom server, falling back through the preset
 * list on failure. The blob is AEAD ciphertext, so its Content-Type is the
 * truthful `application/octet-stream` and the real MIME stays sealed in the
 * `imeta`. A single, server-agnostic request is sent to each store — no
 * per-server content-type logic. We don't mirror (one copy is enough; the
 * `imeta` URL resolves wherever it lives); add mirroring when redundancy
 * against store churn-out is wanted.
 *
 * `onProgress` carries a `number | null`: real byte percent (0–100) while
 * `uploadBlob` is actively sending (drives the progress bar), or `null` for an
 * indeterminate spinner during connect, fallback retries, and the verify-GET +
 * MLS-seal tail after the bar fills.
 */
async function uploadBlobWithFallback(
	blob: Uint8Array,
	signer: BlossomSigner,
	onProgress?: (percent: number | null, phase?: string) => void,
	signal?: AbortSignal
): Promise<{ url: string }> {
	const configured = getBlossomServer();
	// Configured server first, then the remaining presets — deduped by normalized URL
	// (indexOf keeps the first occurrence, so `configured` stays first). Tiny list
	// (~4 servers), so the O(n²) dedupe is irrelevant; avoids a mutable Set, which
	// the svelte/reactivity rule flags in .svelte.ts files.
	const order = [configured, ...BLOSSOM_SERVERS.map((s) => normalizeServerUrl(s))].filter(
		(s, i, arr) => arr.indexOf(s) === i
	);

	let lastError: unknown;
	for (const server of order) {
		// Skip servers already learned to re-encode uploads this session — no point
		// paying the wasted PUT + verify GET again. The first send to a bad server
		// still pays once to learn the verdict.
		if (blobServerVerdict.get(server) === 'bad') continue;
		try {
			// Indeterminate + caption while connecting. Reported before each attempt
			// so a fallback retry shows "Retrying…" (not the bar jumping back to 0);
			// the bar only appears once `uploadBlob` reports real bytes.
			onProgress?.(null, 'Connecting…');
			const uploaded = await uploadBlob({ serverUrl: server, blob, signer, onProgress, signal });
			// `uploadBlob` pinned the bar to 100%; the verify GET + MLS seal tail
			// follows. Hold a "Finalizing…" caption rather than collapsing to a bare
			// spinner so the flow reads as one continuous send.
			onProgress?.(null, 'Finalizing…');
			// Guard against media-optimizer servers that accept the PUT then silently
			// re-encode: served bytes would differ from the stored blob and AEAD
			// decryption would fail for every recipient. A mismatch throws here and
			// the loop falls through to the next server. A server verified
			// byte-faithful earlier this session is trusted (the verdict is a server
			// property), so repeat sends skip the full verify GET.
			if (blobServerVerdict.get(server) !== 'good') {
				await verifyBlobRoundtrip(uploaded.url, uploaded.sha256);
				blobServerVerdict.set(server, 'good');
			}
			return { url: uploaded.url };
		} catch (error) {
			// A user cancel stops the whole upload — don't fall back to another server.
			if (signal?.aborted) throw error;
			// A round-trip mismatch means this server re-encodes uploads — a durable
			// property of the server, so remember it and skip the wasted round next time.
			if (error instanceof Error && /round-trip sha256 mismatch/.test(error.message)) {
				blobServerVerdict.set(server, 'bad');
			}
			lastError = error;
			console.warn(`Blossom upload to ${server} failed:`, error);
			onProgress?.(null, 'Retrying…');
		}
	}
	throw lastError instanceof Error
		? new Error(`All Blossom servers failed. Last: ${lastError.message}`)
		: new Error('All Blossom servers failed');
}

/**
 * Encrypt + upload a media file, then send it as a sealed group message whose
 * envelope carries the `imeta` tag. Caller appends the optimistic message first
 * (with the local preview); this resolves when the sealed message is posted.
 * Fire-and-forget from the composer's perspective: the per-group lock is only
 * held for the final MLS send, not the upload.
 */
export async function sendChatMediaMessage(params: {
	groupId: string;
	file: File;
	text: string;
	/** Extra event tags (mention `p` tags) merged with the imeta tag. */
	tags?: string[][];
	replyTo?: ChatMessageReplyTarget;
	/** Upload-progress reporter: a `number` (0–100) drives a determinate bar;
	 *  `null` + a `phase` caption ("Connecting…", "Finalizing…", "Retrying…")
	 *  covers the indeterminate tails without collapsing back to a bare spinner. */
	onProgress?: (percent: number | null, phase?: string) => void;
	/** Abort the in-flight upload and skip the final MLS send. The caller can
	 *  detect a cancel via its own `signal.aborted` (no special error type). */
	signal?: AbortSignal;
	/** Voice-note metadata to carry in the `imeta` as display hints
	 *  (`duration` + `waveform`). Omitted for non-voice media. */
	voice?: { durationMs: number; waveform: number[] };
}): Promise<void> {
	const { groupId, file, text, tags, replyTo, onProgress, signal, voice } = params;
	// Fail fast before the upload: the final MLS send needs an account, and
	// surfacing it here beats encrypting + uploading first.
	requireActiveAccount('You must be logged in to send media');
	const plaintext = new Uint8Array(await file.arrayBuffer());
	const mime = file.type || 'application/octet-stream';
	const metadata: MediaMetadata = { mime, filename: file.name };

	const group = getChatGroup(groupId);
	if (!group) throw new Error('Group not found');

	// The media key is the MLS exporter for the current epoch, so it must match
	// the epoch the message is sealed at. We encrypt + upload outside the group
	// lock (uploads are slow), then re-check: if a Commit advanced the epoch
	// during the upload, re-derive + re-encrypt + re-upload once so the key
	// matches the new epoch. This collapses the race window from "the whole
	// upload" to the few instructions between this re-check and the sealed send
	// inside sendChatGroupMessage. A true fix would encrypt under the send lock,
	// but that blocks the whole group for the upload duration.
	let state = decodeStoredGroupState(group);
	let key = await deriveMediaKey(state);
	let enc = encryptMedia({ key, plaintext, metadata });
	// Prime the resolved-media cache with the local plaintext so the sender's own confirmed message
	// resolves as a cache hit — no re-download of the just-uploaded blob. The plaintext hash is stable
	// across the epoch-race re-encryption below (same plaintext), so one prime covers both paths.
	cacheResolvedMedia(plaintext, mime, metadata.filename, bytesToHex(enc.plaintextHash));
	const signer = ephemeralBlossomSigner();
	let { url } = await uploadBlobWithFallback(enc.blob, signer, onProgress, signal);

	const latest = getChatGroup(groupId);
	if (latest && decodeStoredGroupState(latest).groupContext.epoch !== state.groupContext.epoch) {
		console.warn('Media epoch advanced during upload; re-encrypting and re-uploading');
		state = decodeStoredGroupState(latest);
		key = await deriveMediaKey(state);
		enc = encryptMedia({ key, plaintext, metadata });
		// ponytail: the epoch-race re-upload is rare and fast; let progress restart
		// from the new upload rather than tracking a high-water mark across calls.
		({ url } = await uploadBlobWithFallback(enc.blob, signer, onProgress, signal));
	}

	// A cancel that landed during the verify-roundtrip / epoch re-check tail
	// (after the PUT bytes finished) must still skip the sealed send.
	if (signal?.aborted) throw new BlossomUploadError('Upload aborted');

	const imeta = buildImetaTag({
		url,
		mime,
		filename: metadata.filename,
		plaintextHashHex: bytesToHex(enc.plaintextHash),
		nonceHex: bytesToHex(enc.nonce),
		version: MEDIA_VERSION,
		durationMs: voice?.durationMs,
		waveform: voice?.waveform
	});

	// A caption can carry custom emoji too. They must be sealed under the same
	// epoch as the attachment; if the epoch moved while they were prepared, send
	// them as text rather than making one row carry two undecryptable keys.
	const mediaKeyBase64 = bytesToBase64(key);
	const captionEmoji = text
		? await prepareEmojiMediaTags(groupId, emojiSourcesForContent(text))
		: { tags: [] };
	const captionTags = captionEmoji.mediaKeyBase64 === mediaKeyBase64 ? captionEmoji.tags : [];

	// Thread the exact encryption key so the sender's stashed copy decrypts the
	// media too (receivers derive their own key at the seal epoch, which the
	// re-check above aligns to the encryption epoch).
	await sendChatGroupMessage({
		groupId,
		content: text,
		tags: [imeta, ...(tags ?? []), ...captionTags],
		replyTo,
		mediaKeyBase64
	});
}

// ---------------------------------------------------------------------------
// Receive: resolve an imeta reference to a viewable ObjectURL, with caching.
// ---------------------------------------------------------------------------

export interface ResolvedMedia {
	/** Object URL of the decrypted plaintext. Caller must NOT revoke it — the
	 *  cache owns the lifecycle and revokes on eviction. */
	readonly url: string;
	readonly mime: string;
	readonly filename: string;
	readonly plaintextHashHex: string;
}

const MAX_MEDIA_CACHE = 50;
// ponytail: a plain object, not a SvelteMap — this is a non-reactive memoization
// cache (resolved blob URLs), not UI state. Reactivity here would force spurious
// re-renders; the $effect caller moves the resolved URL into local $state.
const mediaObjectUrlCache: Record<string, ResolvedMedia> = {};
const mediaCacheOrder: string[] = [];
// ponytail: in-flight dedup. Without it, a virtualizer remount race (or two
// messages sharing one blob) fires two fetch+decrypt+createObjectURL runs for
// the same plaintext hash; the second overwrites the cache entry and the first
// ObjectURL is orphaned (never revoked). Sharing the in-flight promise
// collapses them. Keyed by plaintext hash (`x`) — same `x` is the same file
// regardless of which ciphertext/URL it came from.
const mediaInFlight: Record<string, Promise<ResolvedMedia>> = {};

function revokeMedia(entry: ResolvedMedia): void {
	if (entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url);
}

/**
 * Spawn a one-shot media worker, transfer the ciphertext to it, and await the
 * decrypted plaintext (transferred back). One worker per decrypt — the cache
 * above (keyed by plaintext hash) means each unique image pays this cost at
 * most once per session, so a long-lived worker plus request routing isn't
 * worth it. Mirrors `runBackupWorker` in chatBackup.svelte.ts.
 */
function runMediaWorker(req: MediaDecryptRequest): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./chatMediaWorker.ts', import.meta.url), {
			type: 'module'
		});
		const finish = (res: MediaWorkerResponse) => {
			worker.terminate();
			if (res.ok) resolve(res.plaintext);
			else reject(new Error(res.message));
		};
		worker.onmessage = (event: MessageEvent<MediaWorkerResponse>) => finish(event.data);
		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(event.message || 'Media worker failed to start'));
		};
		// Transfer the ciphertext buffer (zero-copy); key/nonce/hash are tiny and
		// structured-cloned. The buffers are standalone (freshly decoded/fetched),
		// so detaching them on transfer is safe.
		worker.postMessage(req, [req.blob.buffer]);
	});
}

/**
 * Insert a resolved-media entry (decrypted plaintext → ObjectURL) into the cache, keyed by plaintext
 * hash, with FIFO eviction at the cap. Shared by the receive path (after fetch+decrypt) and the send
 * path (priming with the local plaintext so the sender's own just-uploaded media resolves without a
 * second round-trip to the store — the re-download that made a sent video look like it "uploaded
 * twice"). No-op if the hash is already cached.
 */
function cacheResolvedMedia(
	plaintext: Uint8Array,
	mime: string,
	filename: string,
	plaintextHashHex: string
): ResolvedMedia {
	const existing = mediaObjectUrlCache[plaintextHashHex];
	if (existing) return existing;
	const url = URL.createObjectURL(new Blob([plaintext as BlobPart], { type: mime }));
	const resolved: ResolvedMedia = { url, mime, filename, plaintextHashHex };
	mediaObjectUrlCache[plaintextHashHex] = resolved;
	mediaCacheOrder.push(plaintextHashHex);
	if (mediaCacheOrder.length > MAX_MEDIA_CACHE) {
		const oldestKey = mediaCacheOrder.shift()!;
		const oldest = mediaObjectUrlCache[oldestKey];
		delete mediaObjectUrlCache[oldestKey];
		if (oldest) revokeMedia(oldest);
	}
	return resolved;
}

async function resolveMediaReference(
	ref: MediaReference,
	mediaKeyBase64: string | undefined
): Promise<ResolvedMedia | null> {
	if (!isKnownMediaVersion(ref.version) || !mediaKeyBase64) return null;

	const hash = ref.plaintextHashHex;
	const cached = mediaObjectUrlCache[hash];
	if (cached) return cached;
	const existing = mediaInFlight[hash];
	if (existing) return existing;

	mediaInFlight[hash] = (async () => {
		const blob = await fetchBlob(ref.url);
		const plaintext = await runMediaWorker({
			key: base64ToBytes(mediaKeyBase64),
			blob,
			nonce: hexToBytes(ref.nonceHex),
			mime: ref.mime,
			filename: ref.filename,
			expectedPlaintextHash: hexToBytes(hash)
		});

		return cacheResolvedMedia(plaintext, ref.mime, ref.filename, hash);
	})();
	try {
		return await mediaInFlight[hash];
	} finally {
		delete mediaInFlight[hash];
	}
}

/**
 * Resolve a message's `imeta` to a viewable ObjectURL: fetch the encrypted blob
 * from the store, decrypt with the stashed per-epoch key, cache the result.
 * Returns `null` if the message has no media, an unknown version (§4: reject),
 * or no stashed key (pre-`mediaKeyBase64` messages; treated as undecryptable).
 *
 * Idempotent: repeated calls for the same plaintext hash return the cached URL.
 */
export async function resolveMessageMedia(params: {
	messageId: string;
	tags: string[][];
	mediaKeyBase64?: string;
}): Promise<ResolvedMedia | null> {
	const ref = findImetaTag(params.tags);
	return ref ? resolveMediaReference(ref, params.mediaKeyBase64) : null;
}

/** A custom emoji's encrypted picture, opened with the key its row carried at ingest. */
export async function resolveEmojiMedia(
	ref: MediaReference,
	mediaKeyBase64: string | undefined
): Promise<ResolvedMedia | null> {
	return resolveMediaReference(ref, mediaKeyBase64);
}

// ---------------------------------------------------------------------------
// Custom emoji send: one encrypted blob per shortcode, room and epoch.
// ---------------------------------------------------------------------------

export interface EmojiImageSource {
	name: string;
	url: string;
}

const MAX_EMOJI_IMAGE_BYTES = 512 * 1024;
const MAX_EMOJI_IMAGES = 64;
const MAX_EMOJI_MEMOS = 200;
const MAX_EMOJI_TAGS_PER_MESSAGE = 32;
const emojiImageCache = new Map<string, { mime: string; bytes: Uint8Array }>();
const emojiMediaMemo = new Map<string, string[]>();

async function fetchEmojiImage(url: string): Promise<{ mime: string; bytes: Uint8Array }> {
	const cached = emojiImageCache.get(url);
	if (cached) return cached;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	let response: Response;
	try {
		response = await fetch(url, { referrerPolicy: 'no-referrer', signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
	if (!response.ok) throw new Error(`emoji fetch failed: ${response.status}`);
	const declared = Number(response.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > MAX_EMOJI_IMAGE_BYTES) {
		throw new Error('emoji image is too large');
	}
	const reader = response.body?.getReader();
	let bytes: Uint8Array;
	if (reader) {
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
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
		bytes = new Uint8Array(await response.arrayBuffer());
	}
	if (bytes.length === 0 || bytes.length > MAX_EMOJI_IMAGE_BYTES) {
		throw new Error('emoji image is empty or too large');
	}
	const mime = sniffMediaMime(bytes, false);
	// The four raster types Staircase can decode: anything else would be a tag
	// it cannot draw, so it travels as the shortcode instead.
	if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
		throw new Error('emoji is not a supported image');
	}
	const image = { mime, bytes };
	if (emojiImageCache.size >= MAX_EMOJI_IMAGES) {
		const oldest = emojiImageCache.keys().next().value;
		if (oldest) emojiImageCache.delete(oldest);
	}
	emojiImageCache.set(url, image);
	return image;
}

/**
 * Encrypt and upload the pictures for a message's custom emoji, returning the
 * `emoji-media` tags and the key they were sealed under. A source that cannot
 * be fetched or uploaded is skipped: the message still sends.
 */
export async function prepareEmojiMediaTags(
	groupId: string,
	sources: EmojiImageSource[]
): Promise<{ tags: string[][]; mediaKeyBase64?: string }> {
	const unique = sources
		.filter(
			(source, index) =>
				sources.findIndex(
					(candidate) => candidate.name === source.name && candidate.url === source.url
				) === index
		)
		.slice(0, MAX_EMOJI_TAGS_PER_MESSAGE);
	if (unique.length === 0) return { tags: [] };

	// Fetch in parallel: one dead pack host must cost one timeout, not one per
	// emoji in the message. Uploads then stay sequential per try/pass.
	const fetched = (
		await Promise.all(
			unique.map(async (source) => {
				try {
					return { source, image: await fetchEmojiImage(source.url) };
				} catch (error) {
					console.warn(`Could not prepare custom emoji :${source.name}:`, error);
					return null;
				}
			})
		)
	).filter(
		(entry): entry is { source: EmojiImageSource; image: { mime: string; bytes: Uint8Array } } =>
			entry !== null
	);
	if (fetched.length === 0) return { tags: [] };

	// An epoch can move while the uploads run; one retry re-seals under the new key.
	for (let pass = 0; pass < 2; pass++) {
		const group = getChatGroup(groupId);
		if (!group) return { tags: [] };
		const state = decodeStoredGroupState(group);
		const key = await deriveMediaKey(state);
		const keyBase64 = bytesToBase64(key);
		const epoch = String(state.groupContext.epoch);
		const signer = ephemeralBlossomSigner();
		const tags: string[][] = [];

		for (const { source, image } of fetched) {
			const memoKey = `${groupId}:${epoch}:${source.name}:${source.url}`;
			const remembered = emojiMediaMemo.get(memoKey);
			if (remembered) {
				tags.push(remembered);
				continue;
			}
			try {
				const filename = `${source.name}.${mediaExtFromMime(image.mime)}`;
				const enc = encryptMedia({
					key,
					plaintext: image.bytes,
					metadata: { mime: image.mime, filename }
				});
				cacheResolvedMedia(image.bytes, image.mime, filename, bytesToHex(enc.plaintextHash));
				const { url } = await uploadBlobWithFallback(enc.blob, signer);
				const tag = buildMediaTag(EMOJI_MEDIA_TAG, {
					url,
					mime: image.mime,
					filename,
					plaintextHashHex: bytesToHex(enc.plaintextHash),
					nonceHex: bytesToHex(enc.nonce),
					version: MEDIA_VERSION
				});
				// emoji-media names the shortcode it stands behind; the rest is imeta's shape.
				tag.splice(1, 0, `name ${source.name}`);
				if (emojiMediaMemo.size >= MAX_EMOJI_MEMOS) {
					const oldest = emojiMediaMemo.keys().next().value;
					if (oldest) emojiMediaMemo.delete(oldest);
				}
				emojiMediaMemo.set(memoKey, tag);
				tags.push(tag);
			} catch (error) {
				console.warn(`Could not prepare custom emoji :${source.name}:`, error);
			}
		}

		const latest = getChatGroup(groupId);
		if (!latest || decodeStoredGroupState(latest).groupContext.epoch === state.groupContext.epoch) {
			return tags.length > 0 ? { tags, mediaKeyBase64: keyBase64 } : { tags: [] };
		}
	}
	return { tags: [] };
}

/** Extract the imeta reference for rendering (without fetching). Used by the
 *  message item to decide whether to render media + show the filename/alt. */
export function peekMessageMedia(tags: string[][]): MediaReference | null {
	const ref = findImetaTag(tags);
	if (!ref || !isKnownMediaVersion(ref.version)) return null;
	return ref;
}
