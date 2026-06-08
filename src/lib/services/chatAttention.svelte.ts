import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';
import {
	getChatGroupDisplayTitle,
	getChatGroupNotificationIcon
} from '$lib/components/chat/chatGroupDisplay';
import { manager } from '$lib/services/accountManager.svelte';
import {
	getUnreadChatGroupMessageCount,
	getUnreadChatGroupReferenceCount
} from '$lib/services/chatGroupPresence.svelte';
import { SYSTEM_MESSAGE_KIND } from '$lib/services/chatGroupMessages.svelte';
import { getUnreadWelcomeNotificationCount } from '$lib/services/chatWelcomeNotifications.svelte';
import {
	getChatGroup,
	listChatGroupMembers,
	listChatGroupMessages,
	listChatGroups
} from '$lib/services/chatGroups.svelte';

const DEFAULT_TITLE = 'Cordn';
const DEFAULT_FAVICON = '/favicon.svg';

const notificationState = {
	permissionRequested: false,
	lastProcessedCursorByGroup: new Map<string, number>(),
	notifiedMessageIds: new Set<string>()
};

function getBaseTitle(pathname: string) {
	if (pathname.startsWith('/chat/')) {
		const groupId = pathname.split('/')[2];
		const group = groupId ? getChatGroup(groupId) : undefined;
		return group?.metadata?.name ? `${group.metadata.name} | Cordn` : 'Chat | Cordn';
	}

	if (pathname === '/chat') return 'Chat home | Cordn';
	return DEFAULT_TITLE;
}

function getUnreadMessageCount() {
	return listChatGroups().reduce(
		(total, group) => total + getUnreadChatGroupMessageCount(group.id),
		0
	);
}

function getUnreadAttentionCount() {
	const pubkey = manager.active?.pubkey;
	const unreadMessages = getUnreadMessageCount();
	const unreadMentions = pubkey
		? listChatGroups().reduce(
				(total, group) => total + getUnreadChatGroupReferenceCount(group.id, pubkey),
				0
			)
		: 0;
	const unreadWelcomes = getUnreadWelcomeNotificationCount();
	return unreadMessages + unreadMentions + unreadWelcomes;
}

export function hasUnreadChatAttention() {
	return getUnreadAttentionCount() > 0;
}

function buildBadgedTitle(pathname: string) {
	const baseTitle = getBaseTitle(pathname);
	const unreadMessages = getUnreadMessageCount();
	return unreadMessages > 0 ? `(${unreadMessages}) ${baseTitle}` : baseTitle;
}

function ensureFaviconLink() {
	let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!link) {
		link = document.createElement('link');
		link.rel = 'icon';
		document.head.append(link);
	}
	return link;
}

export function syncChatAttention() {
	if (!browser) return;
	document.title = buildBadgedTitle(page.url.pathname);
	ensureFaviconLink().href = DEFAULT_FAVICON;
}

async function requestBrowserNotificationPermission() {
	if (!browser || !('Notification' in window)) return;
	if (Notification.permission !== 'default') return;
	if (notificationState.permissionRequested) return;
	notificationState.permissionRequested = true;
	try {
		await Notification.requestPermission();
	} catch {
		// ignore unsupported/request failures
	}
}

function getNotificationBody(sender: string, content: string) {
	const trimmed = content.trim();
	if (trimmed) return trimmed;
	return `New message from ${sender.slice(0, 12)}…`;
}

function shouldSuppressNotification(groupId: string) {
	const groupPath = `/chat/${groupId}`;
	if (
		document.visibilityState === 'visible' &&
		(page.url.pathname === groupPath || page.url.pathname.startsWith(`${groupPath}/`))
	) {
		return true;
	}
	return false;
}

export async function notifyForUnreadChatMessages() {
	if (!browser) return;
	await requestBrowserNotificationPermission();
	if (!('Notification' in window) || Notification.permission !== 'granted') return;

	const activePubkey = manager.active?.pubkey;
	for (const group of listChatGroups()) {
		const previousCursor = notificationState.lastProcessedCursorByGroup.get(group.id);
		if (previousCursor === undefined) {
			notificationState.lastProcessedCursorByGroup.set(group.id, group.lastCursor);
			continue;
		}

		if (group.lastCursor <= previousCursor) continue;

		const nextMessages = listChatGroupMessages(group.id).filter(
			(message) => message.cursor > previousCursor
		);
		notificationState.lastProcessedCursorByGroup.set(group.id, group.lastCursor);

		if (shouldSuppressNotification(group.id)) continue;

		for (const message of nextMessages) {
			if (message.kind === SYSTEM_MESSAGE_KIND) continue;
			if (message.direction !== 'inbound') continue;
			if (activePubkey && message.sender === activePubkey) continue;
			if (notificationState.notifiedMessageIds.has(message.id)) continue;

			notificationState.notifiedMessageIds.add(message.id);
			const title = getChatGroupDisplayTitle({
				group,
				activePubkey,
				profileHints: {},
				memberPubkeys: listChatGroupMembers(group.id).map((member) => member.stablePubkey)
			});
			const notification = new Notification(title || 'Cordn', {
				body: getNotificationBody(message.sender, message.content),
				icon: getChatGroupNotificationIcon(group) ?? DEFAULT_FAVICON,
				tag: `cordn-group-${group.id}`
			});
			notification.onclick = () => {
				window.focus();
				goto(resolve('/chat/[id]', { id: group.id }));
			};
		}
	}

	for (const group of listChatGroups()) {
		if (!notificationState.lastProcessedCursorByGroup.has(group.id)) {
			notificationState.lastProcessedCursorByGroup.set(group.id, group.lastCursor);
		}
	}
}
