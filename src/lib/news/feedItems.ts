/**
 * Static, build-time news feed for Cordn.
 *
 * News is a global, read-only broadcast — not an MLS group. Releases are
 * authored in {@link newsReleases}; each release is automatically followed by a
 * donation item so the donation cadence ("after each news item") stays
 * consistent without repeating boilerplate.
 *
 * Keep the array ordered newest-first; the feed renders top-down.
 */

export interface NewsRelease {
	id: string;
	createdAt: number;
	title: string;
	body: string;
}

export type NewsFeedItemKind = 'release' | 'donation';

export interface NewsFeedItem {
	id: string;
	kind: NewsFeedItemKind;
	createdAt: number;
	title?: string;
	body: string;
}

/** Stable identifier for the news "channel" (read-state + routing). */
export const NEWS_FEED_ID = 'cordn-news';

const DONATION_BODY =
	'Cordn is free and open source. If it has been useful, consider supporting its development.';

/**
 * Authored releases. Replace and extend this array to publish announcements.
 */
export const newsReleases: NewsRelease[] = [
	{
		id: 'cordn-news-welcome',
		createdAt: Date.UTC(2026, 5, 23),
		title: 'Welcome to Cordn updates',
		body: 'This is where release notes and product news will appear. Replace this placeholder with your first real announcement.'
	}
];

/**
 * Returns the feed items with a donation item inserted right after each release.
 */
export function getNewsFeedItems(): NewsFeedItem[] {
	return newsReleases.flatMap((release) => [
		{
			id: release.id,
			kind: 'release' as const,
			createdAt: release.createdAt,
			title: release.title,
			body: release.body
		},
		{
			id: `${release.id}:donation`,
			kind: 'donation' as const,
			createdAt: release.createdAt,
			body: DONATION_BODY
		}
	]);
}

export function getLatestNewsCreatedAt(): number {
	return newsReleases.reduce((max, release) => Math.max(max, release.createdAt), 0);
}
