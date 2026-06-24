import { browser } from '$app/environment';
import { getLatestNewsCreatedAt, getNewsFeedItems } from './feedItems';

const NEWS_READ_KEY = 'cordn.newsLastReadAt';

/**
 * Global news read cursor. News is the same for everyone (not per-account), so
 * a single localStorage value is enough — intentionally simpler than the
 * per-account chat presence cursors. Works for logged-out users too.
 */
export const newsReadStateStore = $state<{ lastReadAt: number }>({ lastReadAt: 0 });

let loaded = false;

export function loadNewsReadState() {
	if (!browser || loaded) return;
	loaded = true;
	const raw = localStorage.getItem(NEWS_READ_KEY);
	newsReadStateStore.lastReadAt = raw ? Number(raw) || 0 : 0;
}

export function markNewsRead() {
	if (!browser) return;
	const latest = getLatestNewsCreatedAt();
	if (latest <= newsReadStateStore.lastReadAt) return;
	newsReadStateStore.lastReadAt = latest;
	localStorage.setItem(NEWS_READ_KEY, String(latest));
}

/** Count of unread releases (donations don't count toward the badge). */
export function getUnreadNewsCount(): number {
	const since = newsReadStateStore.lastReadAt;
	return getNewsFeedItems().filter((item) => item.kind === 'release' && item.createdAt > since)
		.length;
}

export function hasUnreadNews(): boolean {
	return getLatestNewsCreatedAt() > newsReadStateStore.lastReadAt;
}
