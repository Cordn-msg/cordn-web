import { browser } from '$app/environment';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from 'applesauce-core/helpers';

import { MAX_EMOJI_NAME, isValidEmojiName } from '$lib/chat/emoji';
import { manager } from '$lib/services/accountManager.svelte';
import {
	EmojiImageError,
	emojiImageFailureText,
	fetchEmojiImage
} from '$lib/services/chatEmojiImage';
import { getChatStorage, type StoredEmojiCollectionRecord } from '$lib/storage/chatStorage';
import { safeNormalizePubKey } from '$lib/utils';

/**
 * My collection: pictures saved from the lightbox as the account's own emoji.
 *
 * The bytes are kept (IndexedDB, per account) rather than the URL they came
 * from, because most of those URLs are useless later: a decrypted attachment's
 * URL is a `blob:` that dies with the tab, and a pack host may refuse browser
 * downloads or disappear. A collected picture is therefore also the way an
 * emoji from such a pack becomes sendable — sending reads the stored bytes and
 * never calls the original host.
 */
export interface EmojiCollectionItem {
	/** Lowercase hex sha256 of `bytes`; the same picture is collected once. */
	id: string;
	name: string;
	mime: string;
	filename: string;
	bytes: Uint8Array;
	/** Object URL over `bytes`, for display and as the pending bubble's source. */
	url: string;
	addedAt: number;
}

export type CollectResult =
	| { item: EmojiCollectionItem }
	| {
			error:
				| 'signed-out'
				| 'exists'
				| 'full'
				| 'unreadable'
				| 'unsupported'
				| 'too-large'
				| 'storage';
			detail?: string;
	  };

/** Matches MAX_EMOJI_PACKS' spirit: a browsing-sized list, not an archive. */
const MAX_COLLECTION_ITEMS = 100;

const store = $state<{ owner: string; items: EmojiCollectionItem[]; loaded: boolean }>({
	owner: '',
	items: [],
	loaded: false
});
const objectUrls = new Map<string, string>();
let loading: Promise<void> | null = null;
let loadingFor = '';

function activeOwner(): string {
	const pubkey = manager.getActive()?.pubkey;
	return pubkey ? safeNormalizePubKey(pubkey) : '';
}

function itemFromRecord(record: StoredEmojiCollectionRecord): EmojiCollectionItem {
	let url = objectUrls.get(record.id);
	if (!url) {
		url = URL.createObjectURL(new Blob([record.bytes as BlobPart], { type: record.mime }));
		objectUrls.set(record.id, url);
	}
	return {
		id: record.id,
		name: record.name,
		mime: record.mime,
		filename: record.filename,
		bytes: record.bytes,
		url,
		addedAt: record.addedAt
	};
}

function revoke(ids: Iterable<string>) {
	for (const id of ids) {
		const url = objectUrls.get(id);
		if (url) URL.revokeObjectURL(url);
		objectUrls.delete(id);
	}
}

/** Load an account's collection. Must run outside a derived/template read; anyone
 *  who only needs it loaded should await [ensureEmojiCollectionLoaded]. */
export async function loadEmojiCollectionForOwner(ownerPubkey?: string): Promise<void> {
	const owner = ownerPubkey ? safeNormalizePubKey(ownerPubkey) : '';
	revoke(objectUrls.keys());
	store.owner = owner;
	store.items = [];
	store.loaded = false;
	if (!browser || !owner) {
		store.loaded = true;
		return;
	}
	const records = await (await getChatStorage()).listEmojiCollection(owner);
	if (store.owner !== owner) return;
	store.items = records.map(itemFromRecord);
	store.loaded = true;
}

/** The active account's collection. Pure: account changes load through the watch. */
export function listEmojiCollection(): EmojiCollectionItem[] {
	return activeOwner() === store.owner ? store.items : [];
}

/** Load the active account's collection once, sharing the in-flight load so a
 *  save that starts while the picker is still opening cannot race it. */
export function ensureEmojiCollectionLoaded(): Promise<void> {
	const owner = activeOwner();
	if (!owner) return Promise.resolve();
	if (loading && loadingFor === owner) return loading;
	if (store.owner === owner && store.loaded) return Promise.resolve();
	loadingFor = owner;
	loading = loadEmojiCollectionForOwner(owner).finally(() => {
		if (loadingFor === owner) {
			loading = null;
			loadingFor = '';
		}
	});
	return loading;
}

/** `:name:` spelling of a title or filename: NIP-30 legal, one collision suffix. */
export function collectionName(candidate: string, taken: Set<string>): string {
	const cleaned = candidate
		.replace(/\.[^.]+$/, '')
		.replace(/[^A-Za-z0-9_+-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, MAX_EMOJI_NAME);
	const base = cleaned && isValidEmojiName(cleaned) ? cleaned : 'emoji';
	if (!taken.has(base)) return base;
	for (let suffix = 2; suffix <= MAX_COLLECTION_ITEMS; suffix++) {
		const name = `${base.slice(0, MAX_EMOJI_NAME - String(suffix).length - 1)}_${suffix}`;
		if (!taken.has(name)) return name;
	}
	return base;
}

/**
 * Save the picture behind [url] into the collection. The bytes are read through
 * the same capped, validated path custom emoji sending uses, so what is saved is
 * always something Staircase can draw too.
 */
export async function collectEmojiFromUrl(params: {
	url: string;
	filename?: string;
	name?: string;
}): Promise<CollectResult> {
	const owner = activeOwner();
	if (!owner) return { error: 'signed-out' };
	await ensureEmojiCollectionLoaded();
	if (store.owner !== owner) return { error: 'signed-out' };
	if (store.items.length >= MAX_COLLECTION_ITEMS) return { error: 'full' };

	let bytes: Uint8Array;
	let mime: string;
	try {
		const image = await fetchEmojiImage(params.url);
		bytes = image.bytes;
		mime = image.mime;
	} catch (error) {
		if (error instanceof EmojiImageError && error.reason === 'unsupported') {
			return { error: 'unsupported' };
		}
		if (error instanceof EmojiImageError && error.reason === 'too-large') {
			return { error: 'too-large' };
		}
		return { error: 'unreadable', detail: emojiImageFailureText(error) };
	}

	const id = bytesToHex(sha256(bytes));
	if (store.items.some((item) => item.id === id)) return { error: 'exists' };

	const taken = new Set(store.items.map((item) => item.name));
	const name = collectionName(params.name || params.filename || 'emoji', taken);
	const filename = params.filename || `${name}.${mime.split('/')[1] ?? 'png'}`;
	const record: StoredEmojiCollectionRecord = {
		ownerPubkey: owner,
		id,
		name,
		mime,
		filename,
		bytes,
		addedAt: Date.now()
	};
	const storage = await getChatStorage();
	try {
		await storage.putEmojiCollectionItem(record);
	} catch {
		return { error: 'storage' };
	}
	// The read above can outlast a logout or "log out and clean data". Writing the
	// record back after that cleanup would resurrect wiped data, so undo it.
	if (activeOwner() !== owner) {
		await storage.deleteEmojiCollectionItem(owner, id);
		return { error: 'signed-out' };
	}
	const item = itemFromRecord(record);
	store.items = [...store.items, item];
	return { item };
}

export async function removeEmojiCollectionItem(id: string): Promise<void> {
	const owner = activeOwner();
	if (!owner) return;
	store.items = store.items.filter((item) => item.id !== id);
	revoke([id]);
	await (await getChatStorage()).deleteEmojiCollectionItem(owner, id);
}

/** Drop the whole collection for an account (logout and clean data). */
export async function deleteEmojiCollectionForOwner(ownerPubkey: string): Promise<void> {
	const owner = safeNormalizePubKey(ownerPubkey);
	revoke(objectUrls.keys());
	if (store.owner === owner) {
		store.owner = '';
		store.items = [];
		store.loaded = false;
	}
	await (await getChatStorage()).deleteEmojiCollectionByOwner(owner);
}
