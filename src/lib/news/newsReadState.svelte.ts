import { browser } from '$app/environment';
import { getNewsFeedItems, type NewsFeedItem } from './feedItems';

const NEWS_READ_VERSIONS_KEY = 'cordn.newsReadVersions';
const LEGACY_READ_KEY = 'cordn.newsLastReadAt';

/**
 * Per-release read cursor. News is the same for everyone (not per-account), so
 * one localStorage value is enough — simpler than the per-account chat presence
 * cursors. Works for logged-out users too.
 *
 * We track the highest `version` of each release the user has seen, not a
 * single global max timestamp. Bumping a release's `version` re-flags it
 * unread — so editing an already-read card re-notifies, including multiple
 * same-day edits, while `createdAt` keeps the day label stable. Donations
 * never count toward the badge.
 */
export const newsReadStateStore = $state<{ versions: Record<string, number> }>({ versions: {} });

let loaded = false;

/** True for a release whose current version the user hasn't seen yet. */
function isUnreadRelease(item: NewsFeedItem, versions: Record<string, number>): boolean {
	return item.kind === 'release' && item.version > (versions[item.id] ?? 0);
}

export function loadNewsReadState() {
	if (!browser || loaded) return;
	loaded = true;
	const raw = localStorage.getItem(NEWS_READ_VERSIONS_KEY);
	if (raw) {
		try {
			newsReadStateStore.versions = JSON.parse(raw) ?? {};
		} catch {
			newsReadStateStore.versions = {};
		}
		return;
	}
	// One-time cutover from the legacy global-timestamp cursor: treat every
	// currently published release as already read instead of re-badging it.
	if (localStorage.getItem(LEGACY_READ_KEY) !== null) {
		const versions: Record<string, number> = {};
		for (const item of getNewsFeedItems()) {
			if (item.kind === 'release') versions[item.id] = item.version;
		}
		newsReadStateStore.versions = versions;
		localStorage.setItem(NEWS_READ_VERSIONS_KEY, JSON.stringify(versions));
		localStorage.removeItem(LEGACY_READ_KEY);
	}
}

export function markNewsRead() {
	if (!browser) return;
	let changed = false;
	for (const item of getNewsFeedItems()) {
		if (item.kind !== 'release') continue;
		if ((newsReadStateStore.versions[item.id] ?? 0) < item.version) {
			newsReadStateStore.versions[item.id] = item.version;
			changed = true;
		}
	}
	if (changed) {
		localStorage.setItem(NEWS_READ_VERSIONS_KEY, JSON.stringify(newsReadStateStore.versions));
	}
}

/** Count of unread releases (donations don't count toward the badge). */
export function getUnreadNewsCount(): number {
	return getNewsFeedItems().filter((item) => isUnreadRelease(item, newsReadStateStore.versions))
		.length;
}

export function isNewsItemUnread(item: NewsFeedItem): boolean {
	return isUnreadRelease(item, newsReadStateStore.versions);
}

export function hasUnreadNews(): boolean {
	return getUnreadNewsCount() > 0;
}
