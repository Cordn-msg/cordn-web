import { browser } from '$app/environment';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	areChatGroupsLoaded,
	getChatGroup,
	listChatGroupMessages,
	listChatGroups
} from '$lib/services/chatGroups.svelte';
import { SYSTEM_MESSAGE_KIND } from '$lib/services/chatGroupMessages.svelte';
import { chatMessageReferencesPubkey } from '$lib/services/chatMentions';
import { getChatDraftPreview } from '$lib/services/chatDrafts.svelte';

const STORAGE_KEY = 'cordn-chat-group-presence';
const MAX_PREVIEW_LENGTH = 80;

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

function savePresence() {
	if (!browser) return;
	const payload: PersistedGroupPresence = {
		groups: chatGroupPresenceStore.groups
	};
	localStorage.setItem(activePresenceStorageKey, JSON.stringify(payload));
}

function getPresenceStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

loadChatGroupPresenceForOwner();

export function loadChatGroupPresenceForOwner(ownerPubkey?: string) {
	if (!browser) return;
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
	const storageKey = getPresenceStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activePresenceStorageKey === storageKey) {
		activePresenceStorageKey = getPresenceStorageKey();
	}
	chatGroupPresenceStore.groups = {};
}

export function getChatGroupLastReadCursor(groupId: string): number {
	return chatGroupPresenceStore.groups[groupId]?.lastReadCursor ?? 0;
}

export function markChatGroupRead(groupId: string, cursor?: number) {
	const group = getChatGroup(groupId);
	const nextCursor = cursor ?? group?.lastCursor ?? 0;
	const previous = getChatGroupLastReadCursor(groupId);
	if (nextCursor <= previous) return;

	chatGroupPresenceStore.groups = {
		...chatGroupPresenceStore.groups,
		[groupId]: {
			...chatGroupPresenceStore.groups[groupId],
			lastReadCursor: nextCursor
		}
	};
	savePresence();
}

export function getChatGroupLastReadMentionCursor(groupId: string): number {
	return chatGroupPresenceStore.groups[groupId]?.lastReadMentionCursor ?? 0;
}

export function markChatGroupMentionsRead(groupId: string, cursor: number) {
	const previous = getChatGroupLastReadMentionCursor(groupId);
	if (cursor <= previous) return;

	chatGroupPresenceStore.groups = {
		...chatGroupPresenceStore.groups,
		[groupId]: {
			...chatGroupPresenceStore.groups[groupId],
			lastReadCursor: chatGroupPresenceStore.groups[groupId]?.lastReadCursor ?? 0,
			lastReadMentionCursor: cursor
		}
	};
	savePresence();
}

export function getUnreadChatGroupMessageCount(groupId: string): number {
	const lastReadCursor = getChatGroupLastReadCursor(groupId);
	return listChatGroupMessages(groupId).filter(
		(message) => message.cursor > lastReadCursor && message.kind !== SYSTEM_MESSAGE_KIND
	).length;
}

export function listUnreadChatGroupReferenceTargets(groupId: string, pubkey: string) {
	const lastReadMentionCursor = getChatGroupLastReadMentionCursor(groupId);
	const messages = listChatGroupMessages(groupId);
	const byEventId = new SvelteMap(messages.map((message) => [message.id, message]));

	return messages
		.filter(
			(message) =>
				message.cursor > lastReadMentionCursor &&
				message.sender !== pubkey &&
				chatMessageReferencesPubkey(message.tags, pubkey)
		)
		.map((message) => {
			if (message.kind !== 7) {
				return { reference: message, target: message };
			}

			const targetId = message.tags.find((tag) => tag[0] === 'e')?.[1];
			const target = targetId ? byEventId.get(targetId) : undefined;
			return { reference: message, target: target ?? message };
		});
}

export function getUnreadChatGroupReferenceCount(groupId: string, pubkey: string): number {
	return listUnreadChatGroupReferenceTargets(groupId, pubkey).length;
}

export function getLatestChatGroupMessagePreview(groupId: string): string {
	const draftPreview = getChatDraftPreview(groupId);
	if (draftPreview) {
		return draftPreview;
	}

	const group = getChatGroup(groupId);
	const messages = listChatGroupMessages(groupId);
	let latestMessage: (typeof messages)[number] | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].kind !== SYSTEM_MESSAGE_KIND) {
			latestMessage = messages[i];
			break;
		}
	}
	const preview = latestMessage?.content?.replace(/\s+/g, ' ').trim();
	if (preview) {
		return preview.length > MAX_PREVIEW_LENGTH
			? `${preview.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}…`
			: preview;
	}

	return group?.metadata?.description || 'Group chat';
}

export function pruneChatGroupPresence() {
	if (!areChatGroupsLoaded()) return;

	const validGroupIds = new SvelteSet(listChatGroups().map((group) => group.id));
	const nextEntries = Object.entries(chatGroupPresenceStore.groups).filter(([groupId]) =>
		validGroupIds.has(groupId)
	);
	if (nextEntries.length === Object.keys(chatGroupPresenceStore.groups).length) return;

	chatGroupPresenceStore.groups = Object.fromEntries(nextEntries);
	savePresence();
}

export function removeChatGroupPresence(groupId: string) {
	if (!(groupId in chatGroupPresenceStore.groups)) return;
	const nextGroups = { ...chatGroupPresenceStore.groups };
	delete nextGroups[groupId];
	chatGroupPresenceStore.groups = nextGroups;
	savePresence();
}
