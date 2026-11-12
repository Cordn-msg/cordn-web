import { browser } from '$app/environment';

import {
	MAX_EMOJI_PACKS,
	emojiByName,
	isEmojiUrl,
	isValidEmojiName,
	parseEmojiSetAddress,
	type EmojiPack
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

export type AddEmojiPackResult =
	| { pack: EmojiPack }
	| { error: 'address' | 'exists' | 'full' | 'missing' | 'signed-out' };

export type FetchEmojiPackResult = { pack: EmojiPack } | { error: 'address' | 'missing' };

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

/** The emoji of every active pack plus the collected ones, by shortcode; a
 *  pack wins over a collected emoji with the same name (stable, and the pack is
 *  what the picker shows first). */
export function packEmojiByName(): Map<string, EmojiPackSource> {
	const out = new Map<string, EmojiPackSource>(emojiByName(listEmojiPacks()));
	for (const item of listEmojiCollection()) {
		if (out.has(item.name)) continue;
		out.set(item.name, {
			name: item.name,
			url: item.url,
			coordinate: 'collection',
			bytes: item.bytes,
			mime: item.mime
		});
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
