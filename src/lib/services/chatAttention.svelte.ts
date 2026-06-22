import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';
import {
	getChatGroupDisplayTitle,
	getChatGroupNotificationIcon,
	getRepresentativeMemberPubkey,
	type ChatGroupProfileHints
} from '$lib/components/chat/chatGroupDisplay';
import { manager } from '$lib/services/accountManager.svelte';
import {
	getUnreadChatGroupMessageCount,
	getUnreadChatGroupReferenceCount
} from '$lib/services/chatGroupPresence.svelte';
import { SYSTEM_MESSAGE_KIND } from '$lib/services/chatGroupMessages.svelte';
import { getUnreadWelcomeNotificationCount } from '$lib/services/chatWelcomeNotifications.svelte';
import { getUnreadJoinRequestCount } from '$lib/services/chatJoinRequests.svelte';
import {
	getChatGroup,
	listChatGroupMembers,
	listChatGroups
} from '$lib/services/chatGroups.svelte';
import { eventStore } from '$lib/services/eventStore';
import { firstValueFrom } from 'applesauce-core/observable';
import { ProfileModel } from 'applesauce-core/models';
import type { ProfileContent } from 'applesauce-core/helpers';

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
	const unreadJoinRequests = getUnreadJoinRequestCount();
	return unreadMessages + unreadMentions + unreadWelcomes + unreadJoinRequests;
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

const NOTIFICATION_PROFILE_TIMEOUT_MS = 1500;

/**
 * Reads the current profile for a pubkey from the live event store, bounded by a
 * short timeout so a missing profile never blocks a notification. Maps to the
 * camelCase `ProfileContent` shape consumed by the display helpers (matching
 * `useProfileHints`).
 */
async function resolveProfileHint(pubkey: string): Promise<ProfileContent | undefined> {
	if (!pubkey) return undefined;
	try {
		const profile = await Promise.race([
			firstValueFrom(eventStore.model(ProfileModel, pubkey)),
			new Promise<undefined>((resolve) =>
				setTimeout(() => resolve(undefined), NOTIFICATION_PROFILE_TIMEOUT_MS)
			)
		]);
		if (!profile) return undefined;
		return {
			name: profile.name,
			displayName: profile.display_name,
			nip05: profile.nip05,
			picture: profile.picture
		};
	} catch {
		return undefined;
	}
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

		const nextMessages = group.messages.filter((message) => message.cursor > previousCursor);
		notificationState.lastProcessedCursorByGroup.set(group.id, group.lastCursor);

		if (shouldSuppressNotification(group.id)) continue;

		const memberPubkeys = listChatGroupMembers(group.id).map((member) => member.stablePubkey);
		const profileHints: ChatGroupProfileHints = {};
		const representative = getRepresentativeMemberPubkey(group, { activePubkey, memberPubkeys });
		if (representative) {
			const hint = await resolveProfileHint(representative);
			if (hint) profileHints[representative] = hint;
		}
		const title = getChatGroupDisplayTitle({
			group,
			activePubkey,
			profileHints,
			memberPubkeys
		});
		const icon =
			getChatGroupNotificationIcon(group, { activePubkey, memberPubkeys, profileHints }) ??
			DEFAULT_FAVICON;

		for (const message of nextMessages) {
			if (message.kind === SYSTEM_MESSAGE_KIND) continue;
			if (message.direction !== 'inbound') continue;
			if (activePubkey && message.sender === activePubkey) continue;
			if (notificationState.notifiedMessageIds.has(message.id)) continue;

			notificationState.notifiedMessageIds.add(message.id);
			const notification = new Notification(title || 'Cordn', {
				body: getNotificationBody(message.sender, message.content),
				icon,
				tag: `cordn-group-${group.id}`
			});
			notification.onclick = () => {
				window.focus();
				goto(resolve('/chat/[id]', { id: group.id }));
			};
		}
	}
}
