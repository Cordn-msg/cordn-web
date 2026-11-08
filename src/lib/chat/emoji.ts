import { nip19 } from 'nostr-tools';

/**
 * NIP-30 emoji sets and the two custom-emoji wire forms Cordn understands.
 *
 * Cordn sends Staircase's `emoji-media` tag (a picture re-encrypted to the
 * room) and reads both that and NIP-30's plain `emoji` tag. The set itself is
 * always a NIP-30 kind 30030 event, so packs are shared with other clients.
 */
export const EMOJI_SET_KIND = 30030;
export const EMOJI_MEDIA_TAG = 'emoji-media';
export const MAX_EMOJI_NAME = 32;
export const MAX_EMOJI_PER_PACK = 500;
export const MAX_EMOJI_PACKS = 32;

/** NIP-30 names are alphanumerics, `-` and `_`; `+` is tolerated as Staircase does. */
const NAME_PATTERN = /^[A-Za-z0-9_+-]{1,32}$/;
const SHORTCODE_PATTERN = /:([A-Za-z0-9_+-]{1,32}):/g;
// Same guard as Staircase: a shortcode glued to a word or number is text.
const WORD_CHAR_PATTERN = /[\p{L}\p{N}]/u;
const WHOLE_SHORTCODE_PATTERN = /^:([A-Za-z0-9_+-]{1,32}):$/;
const NADDR_PATTERN = /naddr1[023456789acdefghjklmnpqrstuvwxyz]+/;
const COORDINATE_PATTERN = /^30030:([0-9a-fA-F]{64}):(.*)$/;

export interface PackEmoji {
	name: string;
	url: string;
}

export interface EmojiPack {
	coordinate: string;
	title: string;
	emoji: PackEmoji[];
	/** Relay hints from the naddr this pack was imported through. */
	relays?: string[];
}

export interface EmojiPackAddress {
	pubkey: string;
	identifier: string;
	relays: string[];
	coordinate: string;
}

const EMOJI_MEDIA_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The fields Staircase's `emoji-media` tag shares with `imeta`. */
export interface EmojiMediaReference {
	name: string;
	url: string;
	mime: string;
	filename: string;
	plaintextHashHex: string;
	nonceHex: string;
	version: string;
}

/** One custom emoji an event carries: a plain URL, an encrypted picture, or both. */
export interface EmojiDisplay {
	name: string;
	url?: string;
	media?: EmojiMediaReference;
}

export interface EmojiShortcodeMatch {
	name: string;
	index: number;
	length: number;
}

export interface EmojiSetEventLike {
	kind: number;
	pubkey: string;
	tags: string[][];
	created_at: number;
}

export interface EmojiShortcodeQuery {
	start: number;
	query: string;
}

export function isValidEmojiName(name: string): boolean {
	return NAME_PATTERN.test(name);
}

export function isEmojiUrl(url: string): boolean {
	return (
		(url.startsWith('https://') || url.startsWith('http://')) &&
		url.length > 7 &&
		url.length <= 2048 &&
		!/[\s<>]/.test(url)
	);
}

export function isEmojiRelayUrl(url: string): boolean {
	return /^wss?:\/\//i.test(url);
}

export function shortcode(name: string): string {
	return `:${name}:`;
}

/** The name when `text` is one whole `:name:` and nothing else. */
export function nameOfWholeShortcode(text: string): string | null {
	return WHOLE_SHORTCODE_PATTERN.exec(text.trim())?.[1] ?? null;
}

/** The `:partial` token ending at `caret`, when it starts a word. */
export function shortcodeQueryAt(text: string, caret: number): EmojiShortcodeQuery | null {
	const end = Math.max(0, Math.min(caret, text.length));
	const match = /(^|\s):([A-Za-z0-9_+-]{0,32})$/.exec(text.slice(0, end));
	if (!match) return null;
	const query = match[2];
	return { start: end - query.length - 1, query };
}

/** Drop prepared `emoji-media` tags when the room epoch moved under them. */
export function dropStaleEmojiMediaTags(
	tags: string[][],
	preparedKeyBase64: string | undefined,
	currentKeyBase64: string
): string[][] {
	if (
		!preparedKeyBase64 ||
		preparedKeyBase64 === currentKeyBase64 ||
		!tags.some((tag) => tag[0] === EMOJI_MEDIA_TAG)
	) {
		return tags;
	}
	return tags.filter((tag) => tag[0] !== EMOJI_MEDIA_TAG);
}

/** Every `:name:` in `text`, with the boundary rule that keeps `10:30:00` and `a:b:` as text. */
export function matchEmojiShortcodes(text: string): EmojiShortcodeMatch[] {
	const out: EmojiShortcodeMatch[] = [];
	for (const match of text.matchAll(SHORTCODE_PATTERN)) {
		const index = match.index ?? 0;
		if (index > 0 && WORD_CHAR_PATTERN.test(text[index - 1])) continue;
		out.push({ name: match[1], index, length: match[0].length });
	}
	return out;
}

function tagFields(tag: string[]): Record<string, string> {
	const fields: Record<string, string> = {};
	for (let i = 1; i < tag.length; i++) {
		const entry = tag[i] ?? '';
		const separator = entry.indexOf(' ');
		if (separator <= 0) continue;
		fields[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return fields;
}

/** One `emoji-media` tag, or null when it is not one or a field is missing. */
export function parseEmojiMediaTag(tag: string[]): EmojiMediaReference | null {
	if (tag[0] !== EMOJI_MEDIA_TAG) return null;
	const fields = tagFields(tag);
	const name = fields['name'];
	const url = fields['url'];
	const mime = fields['m'];
	const filename = fields['filename'];
	const plaintextHashHex = fields['x'];
	const nonceHex = fields['n'];
	const version = fields['v'];
	if (!name || !isValidEmojiName(name)) return null;
	if (!url || !isEmojiUrl(url)) return null;
	if (!mime || !EMOJI_MEDIA_MIMES.has(mime) || !filename) return null;
	if (!plaintextHashHex || !nonceHex || !version) return null;
	if (!/^[0-9a-f]{64}$/i.test(plaintextHashHex) || !/^[0-9a-f]{24}$/i.test(nonceHex)) return null;
	return {
		name,
		url,
		mime,
		filename,
		plaintextHashHex: plaintextHashHex.toLowerCase(),
		nonceHex: nonceHex.toLowerCase(),
		version
	};
}

/**
 * The custom emoji an event carries, by shortcode. First tag per name wins;
 * an encrypted picture wins over a plain URL for the same name.
 */
export function emojiMapFromTags(tags: string[][]): Map<string, EmojiDisplay> {
	const out = new Map<string, EmojiDisplay>();
	for (const tag of tags) {
		if (tag[0] !== 'emoji') continue;
		const name = tag[1]?.trim() ?? '';
		const url = tag[2]?.trim() ?? '';
		if (!isValidEmojiName(name) || !isEmojiUrl(url) || out.has(name)) continue;
		out.set(name, { name, url });
	}
	for (const tag of tags) {
		if (tag[0] !== EMOJI_MEDIA_TAG) continue;
		const media = parseEmojiMediaTag(tag);
		if (!media || out.get(media.name)?.media) continue;
		out.set(media.name, { name: media.name, url: out.get(media.name)?.url, media });
	}
	return out;
}

/** The emoji rows of a kind 30030 set, in its own order, skipping bad rows. */
export function emojiInTags(tags: string[][]): PackEmoji[] {
	const out: PackEmoji[] = [];
	const seen = new Set<string>();
	for (const tag of tags) {
		if (tag[0] !== 'emoji' || tag.length < 3) continue;
		const name = tag[1]?.trim() ?? '';
		const url = tag[2]?.trim() ?? '';
		if (!isValidEmojiName(name) || !isEmojiUrl(url) || seen.has(name)) continue;
		seen.add(name);
		out.push({ name, url });
		if (out.length >= MAX_EMOJI_PER_PACK) break;
	}
	return out;
}

/** A kind 30030 event as a pack, or null when it has no address or no usable rows. */
export function parseEmojiSetEvent(event: {
	kind: number;
	pubkey: string;
	tags: string[][];
}): EmojiPack | null {
	if (event.kind !== EMOJI_SET_KIND) return null;
	const pubkey = event.pubkey?.toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
	const dTag = event.tags.find((tag) => tag[0] === 'd');
	if (!dTag || typeof dTag[1] !== 'string') return null;
	const identifier = dTag[1].trim();
	const emoji = emojiInTags(event.tags);
	if (emoji.length === 0) return null;
	const title =
		event.tags.find((tag) => tag[0] === 'title' && tag[1]?.trim())?.[1]?.trim() ?? identifier;
	return {
		coordinate: `${EMOJI_SET_KIND}:${pubkey}:${identifier}`,
		title: title || identifier,
		emoji
	};
}

/** Parse and dedupe pack events by coordinate, newest copy winning. */
export function emojiPacksFromEvents(events: Iterable<EmojiSetEventLike>): EmojiPack[] {
	const newest = new Map<string, { pack: EmojiPack; createdAt: number }>();
	for (const event of events) {
		const pack = parseEmojiSetEvent(event);
		if (!pack) continue;
		const current = newest.get(pack.coordinate);
		if (!current || event.created_at > current.createdAt) {
			newest.set(pack.coordinate, { pack, createdAt: event.created_at });
		}
	}
	return [...newest.values()]
		.map(({ pack }) => pack)
		.sort(
			(a, b) =>
				a.title.toLowerCase().localeCompare(b.title.toLowerCase()) ||
				a.coordinate.localeCompare(b.coordinate)
		);
}

/** An `naddr1…`, `nostr:` URI, link containing one, or bare `30030:` coordinate. */
export function parseEmojiSetAddress(input: string): EmojiPackAddress | null {
	const text = input.trim();
	if (!text) return null;

	const coordinate = COORDINATE_PATTERN.exec(text);
	if (coordinate) {
		const pubkey = coordinate[1].toLowerCase();
		const identifier = coordinate[2];
		return {
			pubkey,
			identifier,
			relays: [],
			coordinate: `${EMOJI_SET_KIND}:${pubkey}:${identifier}`
		};
	}

	const bech32 = NADDR_PATTERN.exec(text)?.[0];
	if (!bech32) return null;
	try {
		const decoded = nip19.decode(bech32);
		if (decoded.type !== 'naddr' || decoded.data.kind !== EMOJI_SET_KIND) return null;
		const pubkey = decoded.data.pubkey.toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
		const identifier = decoded.data.identifier;
		return {
			pubkey,
			identifier,
			relays: (decoded.data.relays ?? []).filter(isEmojiRelayUrl),
			coordinate: `${EMOJI_SET_KIND}:${pubkey}:${identifier}`
		};
	} catch {
		return null;
	}
}

/** Canonical naddr, keeping the relay hints the pack was imported through. */
export function emojiPackNaddr(pack: EmojiPack): string {
	const address = parseEmojiSetAddress(pack.coordinate);
	if (!address) return pack.coordinate;
	const relays = (pack.relays ?? []).filter(isEmojiRelayUrl);
	return nip19.naddrEncode({
		kind: EMOJI_SET_KIND,
		pubkey: address.pubkey,
		identifier: address.identifier,
		...(relays.length > 0 ? { relays } : {})
	});
}

/** Every pack's emoji by shortcode, first pack in the list winning. */
export function emojiByName(packs: EmojiPack[]): Map<string, PackEmoji & { coordinate: string }> {
	const out = new Map<string, PackEmoji & { coordinate: string }>();
	for (const pack of packs) {
		for (const emoji of pack.emoji) {
			if (!out.has(emoji.name)) out.set(emoji.name, { ...emoji, coordinate: pack.coordinate });
		}
	}
	return out;
}
