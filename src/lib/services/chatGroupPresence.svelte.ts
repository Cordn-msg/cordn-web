import { browser } from '$app/environment';
import {
	areChatGroupsLoaded,
	getChatGroup,
	listChatGroupMessages,
	listChatGroups,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import { SYSTEM_MESSAGE_KIND, isAnnotationKind } from '$lib/chat/kinds';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
import { chatMessageReferencesPubkey } from '$lib/services/chatMentions';
import { getChatMessagePreviewText } from '$lib/components/chat/chatGroupDisplay';
import { getChatDraftPreview } from '$lib/services/chatDrafts.svelte';
import { clearShownNotifications } from '$lib/services/nativeBridge';
import { manager } from '$lib/services/accountManager.svelte';
import { samePubKey } from '$lib/utils';

const STORAGE_KEY = 'cordn-chat-group-presence';

type GroupPresenceRecord = {
	lastReadCursor: number;
	lastReadMentionCursor?: number;
};

type PersistedGroupPresence = {
	groups: Record<string, GroupPresenceRecord>;
};

export const chatGroupPresenceStore = $state<{
	groups: Record<string, GroupPresenceRecord>;
}>({
	groups: {}
});

let activePresenceStorageKey = getPresenceStorageKey();

function writePresence() {
	if (!browser) return;
	const payload: PersistedGroupPresence = {
		groups: chatGroupPresenceStore.groups
	};
	localStorage.setItem(activePresenceStorageKey, JSON.stringify(payload));
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function flushPresence() {
	if (saveTimer === undefined) return;
	clearTimeout(saveTimer);
	saveTimer = undefined;
	writePresence();
}

// Trailing debounce: visibility-driven read marking fires in bursts (every
// frame while scrolling), and a synchronous JSON.stringify + localStorage.setItem
// per mark was the 0.5.4 scroll regression. Coalesce to one write per pause.
function scheduleSavePresence() {
	if (!browser) return;
	clearTimeout(saveTimer);
	saveTimer = setTimeout(flushPresence, 300);
}

if (browser) {
	// A pending write must not lose read marks to an abrupt tab close.
	addEventListener('pagehide', flushPresence);
}

function getPresenceStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

export function loadChatGroupPresenceForOwner(ownerPubkey?: string) {
	if (!browser) return;
	// Flush any pending write to the outgoing owner's key before switching.
	flushPresence();
	// Cached summaries pin the outgoing owner's history arrays.
	summaryCache.clear();
	activePresenceStorageKey = getPresenceStorageKey(ownerPubkey);
	try {
		const raw =
			localStorage.getItem(activePresenceStorageKey) ??
			(ownerPubkey ? localStorage.getItem(STORAGE_KEY) : null);
		if (!raw) {
			chatGroupPresenceStore.groups = {};
			return;
		}
		const parsed = JSON.parse(raw) as PersistedGroupPresence;
		chatGroupPresenceStore.groups = parsed.groups ?? {};
	} catch {
		chatGroupPresenceStore.groups = {};
	}
}

export function deleteChatGroupPresenceForOwner(ownerPubkey: string) {
	if (!browser) return;
	flushPresence();
	const storageKey = getPresenceStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activePresenceStorageKey === storageKey) {
		activePresenceStorageKey = getPresenceStorageKey();
	}
	chatGroupPresenceStore.groups = {};
}

/** Read cursor snapshot — exported for open-at-first-unread positioning,
 *  which must capture it before `markChatGroupRead` clears the gap. */
export function getChatGroupLastReadCursor(groupId: string): number {
	return chatGroupPresenceStore.groups[groupId]?.lastReadCursor ?? 0;
}

/** High-water of what the chat actually stores. Ingest pushes in cursor order,
 *  so the tail is the max — maxed with the ingest counter because legacy or
 *  never-refetched records can carry stored messages above `lastCursor`, and
 *  read-marking only the counter leaves the open-at-first-unread scan
 *  re-finding the same "unread" on every open while the badge fast-path
 *  (group.lastCursor <= lastReadCursor) reports zero. */
function getChatGroupStoredHighWater(group: StoredChatGroup | undefined): number {
	return Math.max(group?.lastCursor ?? 0, group?.messages.at(-1)?.cursor ?? 0);
}

export function markChatGroupRead(groupId: string, cursor?: number) {
	const group = getChatGroup(groupId);
	// Omitted cursor = "mark everything stored" (the sidebar action, and the
	// at-bottom visibility report where the whole history has been scrolled
	// past). An explicit cursor is an exact visibility mark — the highest
	// message row currently on screen — trusted, not clamped upward: rows are
	// the source of truth, so a partial mark can't strand the stale-counter
	// records the old blanket clamp existed to cover.
	const nextCursor = cursor ?? getChatGroupStoredHighWater(group);
	const previous = getChatGroupLastReadCursor(groupId);
	if (nextCursor <= previous) return;

	chatGroupPresenceStore.groups = {
		...chatGroupPresenceStore.groups,
		[groupId]: {
			...chatGroupPresenceStore.groups[groupId],
			lastReadCursor: nextCursor
		}
	};
	scheduleSavePresence();
	// Reading dismisses the group's notifications right away — the shade must never outlive
	// the content it points at (platform guidance: drop stale notifications immediately).
	void clearShownNotifications([groupId]);
}

function getChatGroupLastReadMentionCursor(groupId: string): number {
	return chatGroupPresenceStore.groups[groupId]?.lastReadMentionCursor ?? 0;
}

export function markChatGroupMentionsRead(groupId: string, cursor?: number) {
	// Explicit cursor = exact partial mark (one viewed mention); omitted = mark
	// every stored mention (the "mark all read" actions).
	const nextCursor = cursor ?? getChatGroupStoredHighWater(getChatGroup(groupId));
	const previous = getChatGroupLastReadMentionCursor(groupId);
	if (nextCursor <= previous) return;

	chatGroupPresenceStore.groups = {
		...chatGroupPresenceStore.groups,
		[groupId]: {
			...chatGroupPresenceStore.groups[groupId],
			lastReadCursor: chatGroupPresenceStore.groups[groupId]?.lastReadCursor ?? 0,
			lastReadMentionCursor: nextCursor
		}
	};
	scheduleSavePresence();
}

/** Mark every local group fully read (messages + mentions), across all
 *  coordinators. Idempotent: the per-group cursor guards no-op on groups that
 *  are already current. News and invitation badges keep their own read state. */
export function markAllChatGroupsRead() {
	for (const group of listChatGroups()) {
		markChatGroupRead(group.id);
		markChatGroupMentionsRead(group.id);
	}
}

export function listUnreadChatGroupReferenceTargets(groupId: string, pubkey: string) {
	const lastReadMentionCursor = getChatGroupLastReadMentionCursor(groupId);
	const group = getChatGroup(groupId);
	// Same O(1) guard as the summary's unread count (getChatGroupMessageSummary),
	// against the mention cursor: no message exists past lastCursor, so no unread
	// reference either.
	if (!group || group.lastCursor <= lastReadMentionCursor) return [];
	const messages = listChatGroupMessages(groupId);
	const references = messages.filter(
		(message) =>
			message.cursor > lastReadMentionCursor &&
			message.sender !== pubkey &&
			chatMessageReferencesPubkey(message.tags, pubkey)
	);
	// Resolving reply/reaction targets needs the byEventId map (a full-history
	// allocation); plain mentions don't, and they are the common case.
	if (!references.some((message) => isAnnotationKind(message.kind))) {
		return references.map((message) => ({ reference: message, target: message }));
	}
	const byEventId = new Map(messages.map((message) => [message.id, message]));

	return references.map((message) => {
		if (!isAnnotationKind(message.kind)) {
			return { reference: message, target: message };
		}

		const targetId = message.tags.find((tag) => tag[0] === 'e')?.[1];
		const target = targetId ? byEventId.get(targetId) : undefined;
		return { reference: message, target: target ?? message };
	});
}

export interface ChatGroupSummary {
	preview: string;
	unreadCount: number;
	unreadReferenceCount: number;
}

// One pass over history per event (ingest batch, read mark, account change),
// cached — the staircase `recomputeUnread` frequency, without their SQL:
// copy-on-write store writes replace the messages array, so the ref changes
// exactly when history changed. Typing and scrolling leave the cache hot and
// skip the full-history scans that sidebar/attention deriveds used to trigger
// per keystroke. Every input the summary reads is part of the entry or its
// validity check (messages ref, the group's lastCursor + description, both
// read cursors); entries are keyed by the pubkeys the two rules use and
// cleared on account switch and group pruning.
type MessageSummary = {
	messages: StoredChatMessage[] | undefined;
	lastCursor: number;
	description: string | undefined;
	lastReadCursor: number;
	lastReadMentionCursor: number;
	messagePreview: string;
	unreadCount: number;
	unreadReferenceCount: number;
};

const summaryCache = new Map<string, MessageSummary>();

function getChatGroupMessageSummary(
	groupId: string,
	senderPubkey: string | undefined,
	refPubkey: string | undefined
): MessageSummary {
	const group = getChatGroup(groupId);
	const messages = group?.messages;
	const lastCursor = group?.lastCursor ?? 0;
	const description = group?.metadata?.description;
	const lastReadCursor = getChatGroupLastReadCursor(groupId);
	const lastReadMentionCursor = getChatGroupLastReadMentionCursor(groupId);
	const key = `${groupId}\u0000${senderPubkey ?? ''}\u0000${refPubkey ?? ''}`;
	const cached = summaryCache.get(key);
	if (
		cached &&
		cached.messages === messages &&
		cached.lastCursor === lastCursor &&
		cached.description === description &&
		cached.lastReadCursor === lastReadCursor &&
		cached.lastReadMentionCursor === lastReadMentionCursor
	) {
		return cached;
	}

	// Same O(1) guards as before: no message exists past lastCursor, so nothing
	// can be unread either (legacy records carrying stored messages above the
	// counter stay deliberately not badge-counted — see
	// getChatGroupStoredHighWater's comment).
	const countUnread = Boolean(group && group.lastCursor > lastReadCursor);
	let latestMessage: StoredChatMessage | undefined;
	let unreadCount = 0;
	for (const message of messages ?? []) {
		if (!latestMessage || message.cursor > latestMessage.cursor) {
			latestMessage = message;
		}
		if (countUnread && message.cursor > lastReadCursor && message.kind !== SYSTEM_MESSAGE_KIND) {
			// Own messages never count as unread: the coordinator assigns their cursor at
			// validation (the ✓) and echoes them back `direction: 'inbound'`, so without this
			// filter a send would badge its own group as unread. Same rule as the mention
			// scan (`message.sender !== pubkey`); with no active identity there is nothing to
			// attribute, so keep counting rather than hide real unread.
			if (!(senderPubkey && samePubKey(message.sender, senderPubkey))) unreadCount++;
		}
	}

	const preview = latestMessage ? getChatMessagePreviewText(latestMessage) : '';
	const summary: MessageSummary = {
		messages,
		lastCursor,
		description,
		lastReadCursor,
		lastReadMentionCursor,
		// Media and system messages render as labels/sentences (getChatMessagePreviewText);
		// no length cap: cards clip with CSS, and cutting here would slice `nostr:`
		// mention tokens before names replace them — an 80-char cap ate the entire
		// text of any mention-first message.
		messagePreview: preview || description || 'Group chat',
		unreadCount,
		// Single source of truth for the reference matcher and target resolution:
		// the unread-reference list. Cached here so attention/sidebar deriveds never
		// rescan per keystroke.
		unreadReferenceCount: refPubkey
			? listUnreadChatGroupReferenceTargets(groupId, refPubkey).length
			: 0
	};
	summaryCache.set(key, summary);
	return summary;
}

export function getUnreadChatGroupMessageCount(groupId: string): number {
	const activePubkey = manager.active?.pubkey;
	return getChatGroupMessageSummary(groupId, activePubkey, activePubkey).unreadCount;
}

export function getUnreadChatGroupReferenceCount(groupId: string, pubkey: string): number {
	return getChatGroupMessageSummary(groupId, manager.active?.pubkey, pubkey).unreadReferenceCount;
}

export function getChatGroupSummary(groupId: string, activePubkey?: string): ChatGroupSummary {
	const summary = getChatGroupMessageSummary(groupId, manager.active?.pubkey, activePubkey);
	return {
		// Draft previews replace the message preview while composing and change
		// per keystroke — merged outside the cache so it never goes stale.
		preview: getChatDraftPreview(groupId) || summary.messagePreview,
		unreadCount: summary.unreadCount,
		unreadReferenceCount: summary.unreadReferenceCount
	};
}

export function pruneChatGroupPresence() {
	if (!areChatGroupsLoaded()) return;
	// Removed groups' summaries pin history arrays; a full clear is cheap
	// (one pass per group on the next read).
	summaryCache.clear();

	const validGroupIds = new Set(listChatGroups().map((group) => group.id));
	const nextEntries = Object.entries(chatGroupPresenceStore.groups).filter(([groupId]) =>
		validGroupIds.has(groupId)
	);
	if (nextEntries.length === Object.keys(chatGroupPresenceStore.groups).length) return;

	chatGroupPresenceStore.groups = Object.fromEntries(nextEntries);
	scheduleSavePresence();
}

export function removeChatGroupPresence(groupId: string) {
	if (!(groupId in chatGroupPresenceStore.groups)) return;
	const nextGroups = { ...chatGroupPresenceStore.groups };
	delete nextGroups[groupId];
	chatGroupPresenceStore.groups = nextGroups;
	scheduleSavePresence();
}
