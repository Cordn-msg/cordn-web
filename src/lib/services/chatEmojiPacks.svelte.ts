import { browser } from '$app/environment';

import {
	MAX_EMOJI_PACKS,
	emojiByName,
	isEmojiUrl,
	isValidEmojiName,
	matchEmojiShortcodes,
	parseEmojiSetAddress,
	type EmojiPack
} from '$lib/chat/emoji';
import { manager } from '$lib/services/accountManager.svelte';
import { safeNormalizePubKey } from '$lib/utils';

const STORAGE_KEY = 'cordn-chat-emoji-packs';

export interface EmojiPackSource {
	name: string;
	url: string;
	coordinate: string;
}

export type AddEmojiPackResult =
	| { pack: EmojiPack }
	| { error: 'address' | 'exists' | 'full' | 'missing' | 'signed-out' };

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
		)
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

/** The emoji of every active pack by shortcode, first pack winning. */
export function packEmojiByName(): Map<string, EmojiPackSource> {
	return emojiByName(listEmojiPacks());
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

/** The pack emoji a message's content actually names, each once, in text order. */
export function emojiSourcesForContent(content: string): EmojiPackSource[] {
	const byName = packEmojiByName();
	if (byName.size === 0) return [];
	const out: EmojiPackSource[] = [];
	const seen = new Set<string>();
	for (const match of matchEmojiShortcodes(content)) {
		const emoji = byName.get(match.name);
		if (!emoji || seen.has(match.name)) continue;
		seen.add(match.name);
		out.push({ name: emoji.name, url: emoji.url, coordinate: emoji.coordinate });
	}
	return out;
}

export async function addEmojiPack(input: string): Promise<AddEmojiPackResult> {
	const address = parseEmojiSetAddress(input);
	if (!address) return { error: 'address' };
	const owner = activeOwner();
	if (!owner) return { error: 'signed-out' };
	ensureEmojiPacksForActiveAccount();
	const packs = listEmojiPacks();
	if (packs.some((pack) => pack.coordinate === address.coordinate)) return { error: 'exists' };
	if (packs.length >= MAX_EMOJI_PACKS) return { error: 'full' };

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
	if (activeOwner() !== owner) return { error: 'signed-out' };
	save([...listEmojiPacks(), pack]);
	return { pack };
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
