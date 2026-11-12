import { browser } from '$app/environment';

import {
	MAX_EMOJI_PACKS,
	emojiByName,
	isEmojiUrl,
	isValidEmojiName,
	parseEmojiSetAddress,
	type EmojiPack,
	type EmojiPackAddress
} from '$lib/chat/emoji';
import { manager } from '$lib/services/accountManager.svelte';
import { listEmojiCollection } from '$lib/services/chatEmojiCollection.svelte';
import { parseChatProfileMentions } from '$lib/services/chatMentions';
import { safeNormalizePubKey } from '$lib/utils';

const STORAGE_KEY = 'cordn-chat-emoji-packs';

export interface EmojiPackSource {
	name: string;
	url: string;
	coordinate: string;
	/** A collected picture's own bytes: sending one never calls its old host. */
	bytes?: Uint8Array;
	mime?: string;
}

export type EmojiPackError = 'address' | 'exists' | 'full' | 'missing' | 'signed-out';

export type AddEmojiPackResult = { pack: EmojiPack } | { error: EmojiPackError };

export type FetchEmojiPackResult = { pack: EmojiPack } | { error: 'address' | 'missing' };

/** The copy shown when a pack cannot be added. */
export const EMOJI_PACK_ERRORS: Record<EmojiPackError, string> = {
	address: 'Paste an naddr or a 30030: coordinate.',
	exists: 'That pack is already added.',
	full: 'You have reached the pack limit. Remove one first.',
	missing: 'The pack could not be found on the relays.',
	'signed-out': 'Log in to add emoji packs.'
};

const store = $state<{ owner: string; packs: EmojiPack[] }>({ owner: '', packs: [] });

function storageKey(ownerPubkey: string): string {
	return `${STORAGE_KEY}:${ownerPubkey}`;
}

function activeOwner(): string {
	const pubkey = manager.getActive()?.pubkey;
	return pubkey ? safeNormalizePubKey(pubkey) : '';
}

function isStoredPack(value: unknown): value is EmojiPack {
	if (!value || typeof value !== 'object') return false;
	const pack = value as Partial<EmojiPack>;
	return (
		typeof pack.coordinate === 'string' &&
		/^30030:[0-9a-f]{64}:/.test(pack.coordinate) &&
		typeof pack.title === 'string' &&
		Array.isArray(pack.emoji) &&
		pack.emoji.every(
			(emoji) =>
				emoji &&
				typeof emoji === 'object' &&
				typeof emoji.name === 'string' &&
				isValidEmojiName(emoji.name) &&
				typeof emoji.url === 'string' &&
				isEmojiUrl(emoji.url)
		) &&
		(pack.relays === undefined ||
			(Array.isArray(pack.relays) && pack.relays.every((relay) => typeof relay === 'string')))
	);
}

function readEmojiPacksForOwner(ownerPubkey: string): EmojiPack[] {
	if (!browser || !ownerPubkey) return [];
	try {
		const raw = localStorage.getItem(storageKey(ownerPubkey));
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter(isStoredPack) : [];
	} catch {
		return [];
	}
}

/** Load the active account's packs. Must run outside a derived/template read. */
export function loadEmojiPacksForOwner(ownerPubkey?: string): void {
	store.owner = ownerPubkey ? safeNormalizePubKey(ownerPubkey) : '';
	store.packs = readEmojiPacksForOwner(store.owner);
}

function ensureEmojiPacksForActiveAccount(): void {
	const owner = activeOwner();
	if (store.owner !== owner) loadEmojiPacksForOwner(owner);
}

/** The active account's packs. Pure: account changes load through the watch. */
export function listEmojiPacks(): EmojiPack[] {
	const owner = activeOwner();
	return owner === store.owner ? store.packs : readEmojiPacksForOwner(owner);
}

function save(packs: EmojiPack[]): void {
	store.packs = [...packs].sort(
		(a, b) =>
			a.title.toLowerCase().localeCompare(b.title.toLowerCase()) ||
			a.coordinate.localeCompare(b.coordinate)
	);
	if (browser && store.owner) {
		try {
			localStorage.setItem(storageKey(store.owner), JSON.stringify(store.packs));
		} catch {
			// Storage full/blocked: the list still works for this session.
		}
	}
}

/** The emoji of every active pack plus the collected ones, by shortcode. A
 *  collected emoji WINS a name collision: it is the one saved on purpose, and
 *  it is the only one that can be sent without its original host. */
export function packEmojiByName(): Map<string, EmojiPackSource> {
	const out = new Map<string, EmojiPackSource>();
	for (const item of listEmojiCollection()) {
		out.set(item.name, {
			name: item.name,
			url: item.url,
			coordinate: 'collection',
			bytes: item.bytes,
			mime: item.mime
		});
	}
	for (const [name, emoji] of emojiByName(listEmojiPacks())) {
		if (!out.has(name)) out.set(name, emoji);
	}
	return out;
}

/** Plain `emoji` tags for a local preview of `content` (before emoji-media exists). */
export function emojiDisplayTags(content: string): string[][] {
	return emojiSourcesForContent(content).map((emoji) => [
		'emoji',
		emoji.name,
		emoji.url,
		emoji.coordinate
	]);
}

/**
 * The pack emoji a message's content actually names, each once, in text order.
 * Shared with rendering so a shortcode inside a URL stays a URL and is not
 * fetched or encrypted for nothing.
 */
export function emojiSourcesForContent(content: string): EmojiPackSource[] {
	const byName = packEmojiByName();
	if (byName.size === 0) return [];
	const displays = new Map<string, { name: string; url: string }>();
	for (const emoji of byName.values()) {
		displays.set(emoji.name, { name: emoji.name, url: emoji.url });
	}
	const out: EmojiPackSource[] = [];
	const seen = new Set<string>();
	for (const part of parseChatProfileMentions(content, displays)) {
		if (part.type !== 'emoji' || seen.has(part.name)) continue;
		const emoji = byName.get(part.name);
		if (!emoji) continue;
		seen.add(part.name);
		out.push({ ...emoji });
	}
	return out;
}

/** Fetch a pack without saving it, so settings can preview before importing. */
export async function fetchEmojiPack(input: string): Promise<FetchEmojiPackResult> {
	const address = parseEmojiSetAddress(input);
	if (!address) return { error: 'address' };

	let pack: EmojiPack | null = null;
	try {
		const [{ queryClient }, { emojiSetQueryOptions }] = await Promise.all([
			import('$lib/query-client'),
			import('$lib/queries/chatEmojiQueries')
		]);
		pack = await queryClient.fetchQuery({ ...emojiSetQueryOptions(address), staleTime: 0 });
	} catch {
		// A relay timeout and a removed set are the same thing to the person adding it.
	}
	if (!pack) return { error: 'missing' };
	return { pack: { ...pack, ...(address.relays.length ? { relays: address.relays } : {}) } };
}

/** Save a pack that is already in hand (preview, or a chat card's event). */
export function addEmojiPackSnapshot(pack: EmojiPack): AddEmojiPackResult {
	const owner = activeOwner();
	if (!owner) return { error: 'signed-out' };
	ensureEmojiPacksForActiveAccount();
	const packs = listEmojiPacks();
	if (packs.some((candidate) => candidate.coordinate === pack.coordinate)) {
		return { error: 'exists' };
	}
	if (packs.length >= MAX_EMOJI_PACKS) return { error: 'full' };
	save([...packs, pack]);
	return { pack };
}

export interface EmojiListPacks {
	packs: EmojiPack[];
	/** Pointers whose set could not be read from any relay. */
	missing: number;
}

export interface EmojiListImport extends EmojiListPacks {
	/** Resolved packs left unwritten: the pack limit, or another account became active. */
	blocked: number;
}

/**
 * Resolve a published list's pointers through the same per-set query the
 * settings preview uses, so a pack already in hand costs no request. Pointers
 * past the pack limit are left alone: the list could never be imported whole.
 * `refresh` re-asks for sets already cached as missing (the retry affordance).
 */
export async function fetchEmojiPacksFromList(
	addresses: EmojiPackAddress[],
	{ refresh = false }: { refresh?: boolean } = {}
): Promise<EmojiListPacks> {
	const requested = addresses.slice(0, MAX_EMOJI_PACKS);
	const [{ queryClient }, { emojiSetQueryOptions }] = await Promise.all([
		import('$lib/query-client'),
		import('$lib/queries/chatEmojiQueries')
	]);
	const results = await Promise.allSettled(
		requested.map(async (address) => {
			const options = emojiSetQueryOptions(address);
			const pack = await queryClient.fetchQuery(refresh ? { ...options, staleTime: 0 } : options);
			return pack
				? { ...pack, ...(address.relays.length ? { relays: address.relays } : {}) }
				: null;
		})
	);
	const packs: EmojiPack[] = [];
	let missing = 0;
	for (const result of results) {
		if (result.status === 'fulfilled' && result.value) packs.push(result.value);
		else missing += 1;
	}
	return { packs, missing };
}

/**
 * Resolve a published list and write it into the active account's packs, so
 * its shortcodes work right away. A list belongs to the account it was read
 * for: if that account changed while the relays answered, nothing is written.
 */
export async function importEmojiPacksFromList(
	addresses: EmojiPackAddress[],
	ownerPubkey: string,
	{ refresh = false }: { refresh?: boolean } = {}
): Promise<EmojiListImport> {
	const result = await fetchEmojiPacksFromList(addresses, { refresh });
	if (activeOwner() !== safeNormalizePubKey(ownerPubkey)) {
		return { ...result, blocked: result.packs.length };
	}
	let blocked = 0;
	for (const pack of result.packs) {
		const imported = addEmojiPackSnapshot(pack);
		if ('error' in imported && imported.error !== 'exists') blocked += 1;
	}
	return { ...result, blocked };
}

export async function addEmojiPack(input: string): Promise<AddEmojiPackResult> {
	const owner = activeOwner();
	if (!owner) return { error: 'signed-out' };
	const fetched = await fetchEmojiPack(input);
	if ('error' in fetched) return fetched;
	if (activeOwner() !== owner) return { error: 'signed-out' };
	return addEmojiPackSnapshot(fetched.pack);
}

export function removeEmojiPack(coordinate: string): void {
	ensureEmojiPacksForActiveAccount();
	save(listEmojiPacks().filter((pack) => pack.coordinate !== coordinate));
}

export function deleteEmojiPacksForOwner(ownerPubkey: string): void {
	if (!browser) return;
	const owner = safeNormalizePubKey(ownerPubkey);
	localStorage.removeItem(storageKey(owner));
	if (store.owner === owner) {
		store.owner = '';
		store.packs = [];
	}
}
