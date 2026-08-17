import { browser } from '$app/environment';
import { page } from '$app/state';
import {
	clearShownNotifications,
	ensureNotificationPermission,
	isNativePlatform,
	showLocalNotification
} from '$lib/services/nativeBridge';
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
import { SYSTEM_MESSAGE_KIND } from '$lib/chat/kinds';
import { getUnreadWelcomeNotificationCount } from '$lib/services/chatWelcomeNotifications.svelte';
import { getUnreadJoinRequestCount } from '$lib/services/chatJoinRequests.svelte';
import { getUnreadNewsCount } from '$lib/news/newsReadState.svelte';
import {
	getChatGroup,
	listChatGroupMembers,
	listChatGroups
} from '$lib/services/chatGroups.svelte';
import { samePubKey } from '$lib/utils';
import { activeGroupId } from '$lib/utils/groupShareLink';
import { eventStore } from '$lib/services/eventStore';
import { firstValueFrom } from 'applesauce-core/observable';
import { ProfileModel } from 'applesauce-core/models';
import type { ProfileContent } from 'applesauce-core/helpers';

const DEFAULT_TITLE = 'Cordn';
const DEFAULT_FAVICON = '/favicon.svg';

const notificationState = {
	lastProcessedCursorByGroup: new Map<string, number>(),
	notifiedMessageIds: new Set<string>()
};

/** Session cap for the notified-id dedup. FIFO (Set preserves insertion order);
 *  an evicted id could at worst re-notify if the exact same message were
 *  re-processed in one session — unreachable in practice (cursors gate the
 *  scan, and lastProcessedCursorByGroup is checked first). */
const MAX_NOTIFIED_MESSAGE_IDS = 1000;

function rememberNotifiedMessage(messageId: string): void {
	notificationState.notifiedMessageIds.add(messageId);
	if (notificationState.notifiedMessageIds.size > MAX_NOTIFIED_MESSAGE_IDS) {
		const oldest = notificationState.notifiedMessageIds.values().next().value;
		if (oldest !== undefined) notificationState.notifiedMessageIds.delete(oldest);
	}
}

function getBaseTitle(pathname: string) {
	if (pathname.startsWith('/chat/news')) {
		return 'News | Cordn';
	}
	if (pathname.startsWith('/chat/')) {
		// The [id] segment may be a cordn1 ref — decode to the gid before lookup.
		const gid = activeGroupId(pathname);
		const group = gid ? getChatGroup(gid) : undefined;
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
	const unreadNews = getUnreadNewsCount();
	return unreadMessages + unreadMentions + unreadWelcomes + unreadJoinRequests + unreadNews;
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

function getNotificationBody(sender: string, content: string) {
	const trimmed = content.trim();
	if (trimmed) return trimmed;
	return `New message from ${sender.slice(0, 12)}…`;
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
	if (!(await ensureNotificationPermission())) return;

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

		// Attended tab (visible + focused) → the in-app badge/dots already surface attention, so a
		// toast is just noise. Mirrors native's appActive suppression; fires only when backgrounded.
		if (document.visibilityState === 'visible' && document.hasFocus()) continue;

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
			// Default-safe self-filter: without an active identity we can't attribute the message, so
			// stay quiet rather than risk notifying for our own echo. Compare via samePubKey so a
			// signer returning a differently-cased pubkey can't let an own message through a raw ===.
			if (!activePubkey || samePubKey(message.sender, activePubkey)) continue;
			if (notificationState.notifiedMessageIds.has(message.id)) continue;

			rememberNotifiedMessage(message.id);
			await showLocalNotification({
				title: title || 'Cordn',
				body: getNotificationBody(message.sender, message.content),
				icon,
				groupId: group.id
			});
		}
	}
}

/**
 * Web-only: clear shown notifications when the tab returns to the foreground (visible / focus),
 * so a message read in-app doesn't leave a stale toast/shade entry. Native clears via
 * initNativeShell's appStateChange listener; this is a no-op there. Returns a cleanup function —
 * pass directly to onMount. Call once from the chat layout.
 */
export function initNotificationClearOnForeground(): () => void {
	if (!browser || isNativePlatform()) return () => {};
	const clear = () => {
		if (document.visibilityState === 'visible') void clearShownNotifications();
	};
	document.addEventListener('visibilitychange', clear);
	window.addEventListener('focus', clear);
	return () => {
		document.removeEventListener('visibilitychange', clear);
		window.removeEventListener('focus', clear);
	};
}
