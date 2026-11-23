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
	formatChatNotificationLine,
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
import { getNotificationPreviewsEnabled } from '$lib/services/chatNotificationSettings';
import { getChatGroupMuteCutoff, isChatGroupMuted } from '$lib/services/chatGroupMutes.svelte';
import {
	getUnreadWelcomeNotificationCount,
	listWelcomeNotifications
} from '$lib/services/chatWelcomeNotifications.svelte';
import {
	getUnreadJoinRequestCount,
	listJoinRequests,
	type JoinRequestEntry
} from '$lib/services/chatJoinRequests.svelte';
import { profileDisplayLabel } from '$lib/utils/profileName';
import { getUnreadNewsCount } from '$lib/news/newsReadState.svelte';
import {
	getChatGroup,
	listChatGroupMembers,
	listChatGroups,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import { normalizePubKey, samePubKey } from '$lib/utils';
import type { AutoApprovedJoinRequest } from '$lib/services/chatAutoApprove.svelte';
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
		if (sub === 'cal') return `Calendar | ${name ?? 'Chat'} | Cordn`;
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
	// Muted groups stay unread (counts and tab title are unchanged), but they must
	// not raise the red attention dots on the tab bar / back button.
	const groups = listChatGroups().filter(
		(group) => group.id !== excludeGroupId && !isChatGroupMuted(group.id)
	);
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

		// Muted: the cursor above already advanced, so unmuting never replays this
		// backlog as a notification. Messages are still stored and counted as unread.
		if (isChatGroupMuted(group.id)) continue;
		const muteCutoff = getChatGroupMuteCutoff(group.id);

		// Attended tab (visible + focused) → the in-app badge/dots already surface attention, so a
		// toast is just noise. Mirrors native's appActive suppression; fires only when backgrounded.
		if (document.visibilityState === 'visible' && document.hasFocus()) continue;

		const nextMessages = group.messages.filter((message) => message.cursor > previousCursor);

		// One notification per group pass: native shows the last six eligible messages as a
		// thread; web keeps the latest text with a "+N more" suffix because a browser
		// notification cannot stack messages.
		const eligible = nextMessages.filter((message) => {
			if (message.kind === SYSTEM_MESSAGE_KIND) return false;
			if (message.direction !== 'inbound') return false;
			// Never notify for content the user already read — the profile-hint lookup below
			// is async, so an open + read can complete before this post goes out.
			if (message.cursor <= getChatGroupLastReadCursor(group.id)) return false;
			// A fetch that straddles expiry can include messages from the muted window.
			if (muteCutoff > 0 && message.createdAt < muteCutoff) return false;
			// Default-safe self-filter: without an active identity we can't attribute the message, so
			// stay quiet rather than risk notifying for our own echo. Compare via samePubKey so a
			// signer returning a differently-cased pubkey can't let an own message through a raw ===.
			if (!activePubkey || samePubKey(message.sender, activePubkey)) return false;
			if (notificationState.notifiedMessageIds.has(message.id)) return false;
			return true;
		});
		if (eligible.length === 0) continue;

		const previews = getNotificationPreviewsEnabled();
		const memberPubkeys = listChatGroupMembers(group.id).map((member) => member.stablePubkey);
		const representative = getRepresentativeMemberPubkey(group, { activePubkey, memberPubkeys });
		// The title/icon need the 1:1 peer; the thread lines need every sender. All
		// lookups read the in-memory event store and run in parallel, so the worst
		// case stays the single 1.5s timeout rather than one per pubkey.
		const profilePubkeys = new Set<string>();
		if (representative) profilePubkeys.add(representative);
		if (previews) for (const message of eligible.slice(-6)) profilePubkeys.add(message.sender);
		const profileHints: ChatGroupProfileHints = {};
		const hints = await Promise.all(
			[...profilePubkeys].map(async (pubkey) => [pubkey, await resolveProfileHint(pubkey)] as const)
		);
		for (const [pubkey, hint] of hints) {
			if (hint) profileHints[pubkey] = hint;
		}
		// Re-check after the async profile lookups: the user may have muted meanwhile.
		if (isChatGroupMuted(group.id)) continue;
		const title = getChatGroupDisplayTitle({
			group,
			activePubkey,
			profileHints,
			memberPubkeys
		});
		const icon =
			getChatGroupNotificationIcon(group, { activePubkey, memberPubkeys, profileHints }) ??
			DEFAULT_FAVICON;

		for (const message of eligible) rememberNotifiedMessage(message.id);
		const messages = previews
			? eligible.slice(-6).map((message) => ({
					text: formatChatNotificationLine(message, {
						representativePubkey: representative,
						profileHints
					}),
					at: message.createdAt
				}))
			: undefined;
		const latest = messages ? messages[messages.length - 1] : undefined;
		const extra = eligible.length - 1;
		const body = latest
			? latest.text + (extra > 0 ? ` (+${extra} more)` : '')
			: extra > 0
				? `${eligible.length} new messages`
				: 'New message';
		await showLocalNotification({
			title: title || 'Cordn',
			body,
			count: eligible.length,
			messages,
			icon,
			groupId: group.id
		});
	}
}

/**
 * Join requests and welcomes are not messages: their text must survive the
 * "hide previews" setting (a request with no author is useless), so they go
 * through the shared poster with its preview gate bypassed. That keeps the web
 * tracking/close/click wiring and the native foreground suppression in one place.
 */
async function postAttentionNotification(notification: {
	title: string;
	body: string;
	count: number;
	groupId: string;
	openNotifications?: boolean;
}): Promise<void> {
	await showLocalNotification({
		...notification,
		icon: DEFAULT_FAVICON,
		bypassPreviewGate: true
	});
}

/**
 * Dedup: one notification per request/welcome, never repeated by a poll — and
 * persisted per account so a reload or activity recreation doesn't re-announce
 * what the admin already saw. Bounded FIFO; the set only grows with new ids.
 */
const NOTIFIED_STORAGE_KEY = 'cordn-notified-attention';
const MAX_NOTIFIED_IDS = 200;

const notifiedJoinRequestIds = new Set<string>();
const notifiedWelcomeIds = new Set<string>();
let notifiedOwner: string | undefined;

function loadNotifiedIds(): void {
	const owner = normalizePubKey(manager.active?.pubkey ?? '');
	if (owner === notifiedOwner) return;
	notifiedOwner = owner;
	notifiedJoinRequestIds.clear();
	notifiedWelcomeIds.clear();
	if (!owner) return;
	try {
		const raw = localStorage.getItem(`${NOTIFIED_STORAGE_KEY}:${owner}`);
		const parsed = raw ? (JSON.parse(raw) as { joins?: string[]; welcomes?: string[] }) : {};
		for (const id of parsed.joins ?? []) notifiedJoinRequestIds.add(id);
		for (const id of parsed.welcomes ?? []) notifiedWelcomeIds.add(id);
	} catch {
		// corrupt entry — start clean
	}
}

/** "Log out and clean data" must not leave this account's notified ids behind. */
export function deleteNotifiedAttentionForOwner(ownerPubkey: string): void {
	if (!browser) return;
	const owner = normalizePubKey(ownerPubkey);
	try {
		localStorage.removeItem(`${NOTIFIED_STORAGE_KEY}:${owner}`);
	} catch {
		// storage unavailable — nothing to remove
	}
	if (notifiedOwner === owner) {
		notifiedOwner = undefined;
		notifiedJoinRequestIds.clear();
		notifiedWelcomeIds.clear();
	}
}

function rememberNotified(set: Set<string>, id: string): void {
	set.add(id);
	if (set.size > MAX_NOTIFIED_IDS) {
		const oldest = set.values().next().value;
		if (oldest !== undefined) set.delete(oldest);
	}
	if (!notifiedOwner || !browser) return;
	try {
		localStorage.setItem(
			`${NOTIFIED_STORAGE_KEY}:${notifiedOwner}`,
			JSON.stringify({
				joins: [...notifiedJoinRequestIds],
				welcomes: [...notifiedWelcomeIds]
			})
		);
	} catch {
		// quota — the in-memory set still dedupes this session
	}
}

/** The in-app badge already surfaces attention when the app is attended. */
function isAttended(): boolean {
	return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Notify for pending join requests the admin has not been told about yet. One
 * notification per group (the request card list stays the place to act).
 * Call after the join-request poll and its auto-approve pass, so a request the
 * admin's own setting just handled is never announced as pending.
 */
export async function notifyForJoinRequests(): Promise<void> {
	if (!browser) return;
	loadNotifiedIds();
	const pending = listJoinRequests().filter((entry) => !notifiedJoinRequestIds.has(entry.id));
	if (pending.length === 0 || isAttended()) return;
	if (!(await ensureNotificationPermission())) return;

	const byGroup = new Map<string, JoinRequestEntry[]>();
	for (const entry of pending) {
		const list = byGroup.get(entry.groupId) ?? [];
		list.push(entry);
		byGroup.set(entry.groupId, list);
	}
	for (const [groupId, entries] of byGroup) {
		const group = getChatGroup(groupId);
		if (!group) continue;
		const hints = await Promise.all(
			entries.slice(0, 3).map((entry) => resolveProfileHint(entry.requesterStablePubkey))
		);
		const labels = hints.map(
			(hint, index) => profileDisplayLabel(hint, entries[index].requesterStablePubkey) ?? 'Someone'
		);
		const who = labels.length === 1 ? labels[0] : `${labels[0]} and ${entries.length - 1} more`;
		await postAttentionNotification({
			title: group.metadata?.name?.trim() || 'Join request',
			body: `${who} ${entries.length === 1 ? 'wants' : 'want'} to join`,
			count: entries.length,
			groupId,
			openNotifications: true
		});
		// Recorded only after the post: a failed post must retry next pass.
		for (const entry of entries) rememberNotified(notifiedJoinRequestIds, entry.id);
	}
}

/**
 * Notify that the admin's own auto-approve setting let someone in. One per
 * request, replacing the pending "wants to join" announcement for it.
 */
export async function notifyForApprovedJoinRequests(
	approved: AutoApprovedJoinRequest[]
): Promise<void> {
	if (!browser || approved.length === 0) return;
	if (isAttended()) return;
	if (!(await ensureNotificationPermission())) return;

	const byGroup = new Map<string, string[]>();
	for (const { groupId, requester } of approved) {
		const list = byGroup.get(groupId) ?? [];
		list.push(requester);
		byGroup.set(groupId, list);
	}
	for (const [groupId, requesters] of byGroup) {
		const hints = await Promise.all(requesters.slice(0, 3).map(resolveProfileHint));
		const labels = hints.map(
			(hint, index) => profileDisplayLabel(hint, requesters[index]) ?? 'Someone'
		);
		const who = labels.length === 1 ? labels[0] : `${labels[0]} and ${requesters.length - 1} more`;
		// No `openNotifications`: the request is gone from the dialog, so the tap
		// lands on the group where the member-added message is.
		await postAttentionNotification({
			title: getChatGroup(groupId)?.metadata?.name?.trim() || 'Join request approved',
			body: `Approved ${who}`,
			count: requesters.length,
			groupId
		});
	}
}

/** Notify for group invitations (welcomes) the reader has not been told about yet. */
export async function notifyForWelcomes(): Promise<void> {
	if (!browser) return;
	loadNotifiedIds();
	const pending = listWelcomeNotifications().filter((entry) => !notifiedWelcomeIds.has(entry.id));
	if (pending.length === 0 || isAttended()) return;
	if (!(await ensureNotificationPermission())) return;

	for (const entry of pending) {
		// A welcome without a preview has no group to open yet; leave it unrecorded
		// so the next pass retries once the preview resolves.
		const gid = entry.preview?.gid;
		if (!gid) continue;
		await postAttentionNotification({
			title: entry.preview?.name?.trim() || 'Group invitation',
			body: 'You have been invited to join',
			count: 1,
			groupId: gid
		});
		rememberNotified(notifiedWelcomeIds, entry.id);
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
