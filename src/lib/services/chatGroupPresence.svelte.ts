import { browser } from '$app/environment';
import {
	areChatGroupsLoaded,
	getChatGroup,
	listChatGroupMessages,
	listChatGroups
} from '$lib/services/chatGroups.svelte';

const STORAGE_KEY = 'cordn-chat-group-presence';

type GroupPresenceRecord = {
	lastReadCursor: number;
};

type PersistedGroupPresence = {
	groups: Record<string, GroupPresenceRecord>;
};

export const chatGroupPresenceStore = $state<{
	groups: Record<string, GroupPresenceRecord>;
}>({
	groups: {}
});

function savePresence() {
	if (!browser) return;
	const payload: PersistedGroupPresence = {
		groups: chatGroupPresenceStore.groups
	};
	localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadPresence() {
	if (!browser) return;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedGroupPresence;
		chatGroupPresenceStore.groups = parsed.groups ?? {};
	} catch {
		chatGroupPresenceStore.groups = {};
	}
}

loadPresence();

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
			lastReadCursor: nextCursor
		}
	};
	savePresence();
}

export function getUnreadChatGroupMessageCount(groupId: string): number {
	const lastReadCursor = getChatGroupLastReadCursor(groupId);
	return listChatGroupMessages(groupId).filter((message) => message.cursor > lastReadCursor).length;
}

export function getLatestChatGroupMessagePreview(groupId: string): string {
	const group = getChatGroup(groupId);
	const latestMessage = listChatGroupMessages(groupId).at(-1);
	return latestMessage?.content?.trim() || group?.metadata?.description || 'Group chat';
}

export function pruneChatGroupPresence() {
	if (!areChatGroupsLoaded()) return;

	const validGroupIds = new Set(listChatGroups().map((group) => group.id));
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
