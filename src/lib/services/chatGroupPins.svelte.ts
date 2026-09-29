import { browser } from '$app/environment';
import { SvelteSet } from 'svelte/reactivity';

/**
 * Per-account pinned groups ("keep at the top of the list"). Same persistence
 * model as chatGroupPresence: one localStorage key per owner pubkey, loaded on
 * account change, deleted on logout. Pins are device-local read-state,
 * intentionally not synced.
 */
const STORAGE_KEY = 'cordn-chat-group-pins';

const chatGroupPinsStore = $state({ groupIds: new SvelteSet<string>() });

let activePinsStorageKey = getPinsStorageKey();

function getPinsStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

function savePins() {
	if (!browser) return;
	localStorage.setItem(activePinsStorageKey, JSON.stringify([...chatGroupPinsStore.groupIds]));
}

export function loadChatGroupPinsForOwner(ownerPubkey?: string) {
	if (!browser) return;
	activePinsStorageKey = getPinsStorageKey(ownerPubkey);
	try {
		const raw = localStorage.getItem(activePinsStorageKey);
		chatGroupPinsStore.groupIds = new SvelteSet(raw ? (JSON.parse(raw) as string[]) : []);
	} catch {
		chatGroupPinsStore.groupIds = new SvelteSet();
	}
}

export function deleteChatGroupPinsForOwner(ownerPubkey: string) {
	if (!browser) return;
	const storageKey = getPinsStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activePinsStorageKey === storageKey) {
		activePinsStorageKey = getPinsStorageKey();
	}
	chatGroupPinsStore.groupIds = new SvelteSet();
}

export function isChatGroupPinned(groupId: string): boolean {
	return chatGroupPinsStore.groupIds.has(groupId);
}

export function toggleChatGroupPin(groupId: string): void {
	if (chatGroupPinsStore.groupIds.has(groupId)) {
		chatGroupPinsStore.groupIds.delete(groupId);
	} else {
		chatGroupPinsStore.groupIds.add(groupId);
	}
	savePins();
}

/** Drop a pin when its group is deleted locally, mirroring removeChatGroupPresence. */
export function removeChatGroupPin(groupId: string) {
	if (!chatGroupPinsStore.groupIds.has(groupId)) return;
	chatGroupPinsStore.groupIds.delete(groupId);
	savePins();
}
