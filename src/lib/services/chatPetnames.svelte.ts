import { browser } from '$app/environment';
import { safeNormalizePubKey } from '$lib/utils';

/**
 * Local-first petnames: the account holder's own name for a pubkey ("Mom",
 * "Work — John"). One localStorage key per owner, the same persistence model as
 * chatGroupPins/chatGroupPresence. Nothing is published or synced — a petname
 * never leaves this device — and writes are synchronous because this is user
 * data, not a cache.
 *
 * Read by the single display-name policy in `utils/profileName.ts`, so every
 * surface (bubbles, mentions, titles, notifications) resolves petnames through
 * that one chain.
 */
const STORAGE_KEY = 'cordn-chat-petnames';
/** Long enough for "Work — John (the designer)", short enough for a name slot. */
const MAX_PETNAME_LENGTH = 64;

export const chatPetnamesStore = $state<{ names: Record<string, string> }>({ names: {} });

let activeStorageKey = storageKeyFor();

function storageKeyFor(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

/** Stored keys are lowercase hex; a malformed peer pubkey still gets a stable key. */
function petnameKey(pubkey: string): string {
	return safeNormalizePubKey(pubkey) || pubkey.trim().toLowerCase();
}

function sanitizeNames(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const names: Record<string, string> = {};
	for (const [pubkey, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== 'string') continue;
		const name = value.replace(/\s+/g, ' ').trim().slice(0, MAX_PETNAME_LENGTH);
		if (!pubkey || !name) continue;
		names[petnameKey(pubkey)] = name;
	}
	return names;
}

function savePetnames() {
	if (!browser) return;
	try {
		localStorage.setItem(activeStorageKey, JSON.stringify(chatPetnamesStore.names));
	} catch {
		// Quota/private mode: the petnames still apply for this session.
	}
}

export function loadChatPetnamesForOwner(ownerPubkey?: string) {
	if (!browser) return;
	activeStorageKey = storageKeyFor(ownerPubkey);
	try {
		const raw = localStorage.getItem(activeStorageKey);
		chatPetnamesStore.names = raw ? sanitizeNames(JSON.parse(raw)) : {};
	} catch {
		chatPetnamesStore.names = {};
	}
}

export function deleteChatPetnamesForOwner(ownerPubkey: string) {
	if (!browser) return;
	const storageKey = storageKeyFor(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activeStorageKey === storageKey) {
		activeStorageKey = storageKeyFor();
		chatPetnamesStore.names = {};
	}
}

export function getChatPetname(pubkey: string): string | undefined {
	if (!pubkey) return undefined;
	return chatPetnamesStore.names[petnameKey(pubkey)];
}

/** Set (or, with an empty name, clear) the local name for [pubkey]. */
export function setChatPetname(pubkey: string, name: string): void {
	const key = petnameKey(pubkey);
	if (!key) return;
	const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, MAX_PETNAME_LENGTH);
	if (trimmed) chatPetnamesStore.names[key] = trimmed;
	else delete chatPetnamesStore.names[key];
	savePetnames();
}

export function clearChatPetname(pubkey: string) {
	const key = petnameKey(pubkey);
	if (chatPetnamesStore.names[key] === undefined) return;
	delete chatPetnamesStore.names[key];
	savePetnames();
}
