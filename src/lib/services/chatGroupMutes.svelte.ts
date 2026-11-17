import { browser } from '$app/environment';
import { SvelteMap } from 'svelte/reactivity';

/**
 * Per-account notification mutes, device-local and never synced (same model as
 * chatGroupPins). A group is muted until an absolute timestamp, or forever.
 *
 * Muting never touches message ingestion, unread counts or the coordinator — it
 * only gates the web and Android notification posters. The cutoff is kept after
 * expiry and after a manual unmute so Android can tell a delayed background
 * fetch's backlog (sent during the mute) from genuinely new messages.
 */
const STORAGE_KEY = 'cordn-chat-group-mutes';

/** Negative sentinel: muted until unmuted. Positive values are expiry timestamps. */
export const CHAT_GROUP_MUTE_ALWAYS = -1;

export const CHAT_GROUP_MUTE_OPTIONS = [
	{ label: '1 hour', ms: 60 * 60 * 1000 },
	{ label: '8 hours', ms: 8 * 60 * 60 * 1000 },
	{ label: '1 day', ms: 24 * 60 * 60 * 1000 },
	{ label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
	{ label: 'Always', ms: CHAT_GROUP_MUTE_ALWAYS }
] as const;

const chatGroupMutesStore = $state({
	mutes: new SvelteMap<string, number>(),
	/** Ticks at the next expiry so muted icons and menu labels re-render. */
	now: Date.now()
});

let activeMutesStorageKey = getMutesStorageKey();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function getMutesStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

function saveMutes() {
	if (!browser) return;
	localStorage.setItem(
		activeMutesStorageKey,
		JSON.stringify(Object.fromEntries(chatGroupMutesStore.mutes))
	);
}

/** One timer to the nearest timed expiry; correctness never depends on it firing. */
function scheduleExpiry() {
	if (!browser) return;
	if (expiryTimer !== undefined) clearTimeout(expiryTimer);
	expiryTimer = undefined;
	const now = Date.now();
	let next = Infinity;
	for (const cutoff of chatGroupMutesStore.mutes.values()) {
		if (cutoff > now && cutoff < next) next = cutoff;
	}
	if (next === Infinity) return;
	expiryTimer = setTimeout(
		() => {
			expiryTimer = undefined;
			chatGroupMutesStore.now = Date.now();
			scheduleExpiry();
		},
		Math.min(next - now, 2 ** 31 - 1)
	);
}

export function loadChatGroupMutesForOwner(ownerPubkey?: string) {
	if (!browser) return;
	activeMutesStorageKey = getMutesStorageKey(ownerPubkey);
	try {
		const raw = localStorage.getItem(activeMutesStorageKey);
		const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		const mutes = new SvelteMap<string, number>();
		for (const [groupId, cutoff] of Object.entries(parsed)) {
			if (typeof cutoff === 'number' && Number.isFinite(cutoff)) mutes.set(groupId, cutoff);
		}
		chatGroupMutesStore.mutes = mutes;
	} catch {
		chatGroupMutesStore.mutes = new SvelteMap();
	}
	chatGroupMutesStore.now = Date.now();
	scheduleExpiry();
}

export function deleteChatGroupMutesForOwner(ownerPubkey: string) {
	if (!browser) return;
	const storageKey = getMutesStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activeMutesStorageKey === storageKey) {
		activeMutesStorageKey = getMutesStorageKey();
	}
	chatGroupMutesStore.mutes = new SvelteMap();
	scheduleExpiry();
}

/** True while [cutoff] suppresses notifications. Pure, so callers can test boundaries. */
export function isMuteCutoffActive(cutoff: number, now = Date.now()): boolean {
	// Any negative value is the always-sentinel (matching the native helper).
	return cutoff < 0 || cutoff > now;
}

/** 0 = never muted, [CHAT_GROUP_MUTE_ALWAYS] = always, positive = muted until. */
export function getChatGroupMuteCutoff(groupId: string): number {
	return chatGroupMutesStore.mutes.get(groupId) ?? 0;
}

export function isChatGroupMuted(groupId: string): boolean {
	// Read the reactive clock for UI updates, but decide on the real clock: a
	// throttled background timer must never extend a mute past its expiry.
	void chatGroupMutesStore.now;
	return isMuteCutoffActive(getChatGroupMuteCutoff(groupId), Date.now());
}

/** Human label for the muted icon; empty when not muted. */
export function getChatGroupMuteLabel(groupId: string): string {
	const cutoff = getChatGroupMuteCutoff(groupId);
	if (!isMuteCutoffActive(cutoff)) return '';
	if (cutoff < 0) return 'Notifications muted';
	const until = new Date(cutoff).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
	return `Notifications muted until ${until}`;
}

/** Mute for [durationMs], or [CHAT_GROUP_MUTE_ALWAYS]. Returns the stored cutoff. */
export function muteChatGroup(groupId: string, durationMs: number): number {
	const cutoff =
		durationMs === CHAT_GROUP_MUTE_ALWAYS ? CHAT_GROUP_MUTE_ALWAYS : Date.now() + durationMs;
	chatGroupMutesStore.mutes.set(groupId, cutoff);
	chatGroupMutesStore.now = Date.now();
	saveMutes();
	scheduleExpiry();
	return cutoff;
}

/**
 * Unmute now, keeping a cutoff at this instant. A background fetch that was in
 * flight during the mute then treats its whole backlog as pre-unmute and stays quiet.
 */
export function unmuteChatGroup(groupId: string): number {
	const cutoff = Date.now();
	chatGroupMutesStore.mutes.set(groupId, cutoff);
	chatGroupMutesStore.now = cutoff;
	saveMutes();
	scheduleExpiry();
	return cutoff;
}

/** Drop the record when its group is deleted locally, mirroring removeChatGroupPin. */
export function removeChatGroupMute(groupId: string) {
	if (!chatGroupMutesStore.mutes.delete(groupId)) return;
	saveMutes();
	scheduleExpiry();
}
