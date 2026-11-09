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
	formatChatNotificationBody,
	getRepresentativeMemberPubkey,
	type ChatGroupProfileHints
} from '$lib/components/chat/chatGroupDisplay';
import { manager } from '$lib/services/accountManager.svelte';
import {
	getChatGroupLastReadCursor,
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
	listChatGroups,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import { samePubKey } from '$lib/utils';
import { resolveGroupLocator } from '$lib/utils/groupShareLink';
import { getCoordinatorLabel } from '$lib/services/chatCoordinators.svelte';
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

/** The one page-title table. syncChatAttention is the single writer (route
 *  heads must not set <title>, or the unread badge flips between writers);
 *  labels mirror the route titles these replaced. */
function getBaseTitle(pathname: string) {
	if (pathname === '/chat') return manager.active ? 'Chats | Cordn' : DEFAULT_TITLE;
	if (pathname.startsWith('/chat/news')) return 'News & updates | Cordn';
	if (pathname.startsWith('/chat/create-group')) return 'Create group | Cordn';
	if (pathname.startsWith('/chat/share')) return 'Share to… | Cordn';
	if (pathname.startsWith('/chat/config/chat')) return 'Chat behavior | Cordn';
	if (pathname.startsWith('/chat/config/notifications')) return 'Notifications | Cordn';
	if (pathname.startsWith('/chat/config/appearance')) return 'Appearance | Cordn';
	if (pathname.startsWith('/chat/config/backup')) return 'Backup & recovery | Cordn';
	if (pathname.startsWith('/chat/config/key-packages')) return 'Key packages | Cordn';
	if (pathname.startsWith('/chat/config/media')) return 'Media | Cordn';
	if (pathname.startsWith('/chat/config')) return 'Settings | Cordn';
	if (pathname.startsWith('/chat/coordinators/')) {
		const key = decodeURIComponent(pathname.slice('/chat/coordinators/'.length));
		return key ? `${getCoordinatorLabel(key)} | Cordn` : 'Coordinators | Cordn';
	}
	if (pathname.startsWith('/chat/coordinators')) return 'Coordinators | Cordn';
	if (pathname.startsWith('/chat/')) {
		// Group routes incl. /info and /e sub-paths: the [id] segment may be a
		// cordn1 ref or a bare gid — resolve like the route does, so an unjoined
		// share-link page still titles with the shared name.
		const segment = pathname.split('/')[2] ?? '';
		const locator = resolveGroupLocator(segment, page.url.searchParams);
		const group = locator.gid ? getChatGroup(locator.gid) : undefined;
		const name = group?.metadata?.name || locator.shareMetadata?.name;
		const sub = pathname.split('/')[3];
		if (sub === 'info') {
			let displayTitle = '';
			try {
				displayTitle = group
					? getChatGroupDisplayTitle({
							group,
							activePubkey: manager.active?.pubkey,
							memberPubkeys: listChatGroupMembers(group.id).map((member) => member.stablePubkey)
						})
					: '';
			} catch {
				// Corrupt stored state: the info page reports it on its own — a throw
				// here would kill the attention effect (and the badge) for good.
			}
			return `${displayTitle || 'Group info'} | Cordn`;
		}
		if (sub === 'e') return `Message | ${name ?? 'Chat'} | Cordn`;
		return `${name || 'Chat'} | Cordn`;
	}
	return DEFAULT_TITLE;
}

function getUnreadMessageCount() {
	return listChatGroups().reduce(
		(total, group) => total + getUnreadChatGroupMessageCount(group.id),
		0
	);
}

function getUnreadAttentionCount(excludeGroupId?: string) {
	const pubkey = manager.active?.pubkey;
	const groups = listChatGroups().filter((group) => group.id !== excludeGroupId);
	const unreadMessages = groups.reduce(
		(total, group) => total + getUnreadChatGroupMessageCount(group.id),
		0
	);
	const unreadMentions = pubkey
		? groups.reduce((total, group) => total + getUnreadChatGroupReferenceCount(group.id, pubkey), 0)
		: 0;
	const unreadWelcomes = getUnreadWelcomeNotificationCount();
	const unreadJoinRequests = getUnreadJoinRequestCount();
	const unreadNews = getUnreadNewsCount();
	return unreadMessages + unreadMentions + unreadWelcomes + unreadJoinRequests + unreadNews;
}

/** Any unread attention anywhere. Pass the open group's id (chat routes) to
 *  signal "something new elsewhere" — the open group is being read, so its
 *  unread (e.g. not-yet-viewed mentions) must not pin the dot forever. */
export function hasUnreadChatAttention(excludeGroupId?: string) {
	return getUnreadAttentionCount(excludeGroupId) > 0;
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
	// Write-on-change: the caller effect re-runs per ingested batch, and
	// identical title/favicon writes are pure churn (measured 50/s in bursts).
	const title = buildBadgedTitle(page.url.pathname);
	if (document.title !== title) document.title = title;
	const favicon = ensureFaviconLink();
	if (favicon.getAttribute('href') !== DEFAULT_FAVICON) favicon.href = DEFAULT_FAVICON;
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

	const activePubkey = manager.active?.pubkey;
	// Cheap pre-pass: seed never-seen groups and collect the ones with new
	// cursors. This runs per ingested batch (the chat layout effect), so the
	// permission gate — a native bridge call — must not run when there is
	// nothing to notify.
	const pending: Array<{ group: StoredChatGroup; previousCursor: number }> = [];
	for (const group of listChatGroups()) {
		const previousCursor = notificationState.lastProcessedCursorByGroup.get(group.id);
		if (previousCursor === undefined) {
			notificationState.lastProcessedCursorByGroup.set(group.id, group.lastCursor);
			continue;
		}

		if (group.lastCursor > previousCursor) pending.push({ group, previousCursor });
	}
	if (pending.length === 0) return;
	if (!(await ensureNotificationPermission())) return;

	for (const { group, previousCursor } of pending) {
		notificationState.lastProcessedCursorByGroup.set(group.id, group.lastCursor);

		// Attended tab (visible + focused) → the in-app badge/dots already surface attention, so a
		// toast is just noise. Mirrors native's appActive suppression; fires only when backgrounded.
		if (document.visibilityState === 'visible' && document.hasFocus()) continue;

		const nextMessages = group.messages.filter((message) => message.cursor > previousCursor);

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

		// One notification per group pass: notify the LAST eligible message with a "+N more"
		// suffix instead of one toast per message — a busy burst in several groups otherwise floods
		// the shade (the web Notification tag only collapses same-group entries, native posts N).
		const eligible = nextMessages.filter((message) => {
			if (message.kind === SYSTEM_MESSAGE_KIND) return false;
			if (message.direction !== 'inbound') return false;
			// Never notify for content the user already read — the profile-hint lookup below
			// is async, so an open + read can complete before this post goes out.
			if (message.cursor <= getChatGroupLastReadCursor(group.id)) return false;
			// Default-safe self-filter: without an active identity we can't attribute the message, so
			// stay quiet rather than risk notifying for our own echo. Compare via samePubKey so a
			// signer returning a differently-cased pubkey can't let an own message through a raw ===.
			if (!activePubkey || samePubKey(message.sender, activePubkey)) return false;
			if (notificationState.notifiedMessageIds.has(message.id)) return false;
			return true;
		});
		if (eligible.length === 0) continue;

		for (const message of eligible) rememberNotifiedMessage(message.id);
		const last = eligible[eligible.length - 1]!;
		const extra = eligible.length - 1;
		const body =
			formatChatNotificationBody(last.sender, last, profileHints) +
			(extra > 0 ? ` (+${extra} more)` : '');
		await showLocalNotification({
			title: title || 'Cordn',
			body,
			icon,
			groupId: group.id
		});
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
