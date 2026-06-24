/**
 * Static, build-time news feed for Cordn.
 *
 * News is a global, read-only broadcast — not an MLS group. Releases are
 * authored in {@link newsReleases}; each release is automatically followed by a
 * donation item so the donation cadence ("after each news item") stays
 * consistent without repeating boilerplate. A release can override the default
 * donation (or opt out with `donation: false`).
 *
 * Release and donation bodies are Markdown; see {@link parseMarkdown} for the
 * supported subset. Only author trusted content here — the renderer does not
 * escape HTML.
 *
 * Keep the array ordered newest-first; the feed renders top-down.
 */

export interface NewsRelease {
	id: string;
	createdAt: number;
	title: string;
	/** Markdown body. */
	body: string;
	/** Override the default donation, or `false` to suppress it for this release. */
	donation?: Partial<DonationConfig> | false;
}

export interface DonationConfig {
	/** Eyebrow label on the inline donation card. */
	eyebrow: string;
	/** Markdown body shown on the inline card. */
	body: string;
	/** Inline "Donate" button label. */
	ctaLabel: string;
	/** Lightning address (LUD-16) the donation dialog zaps. */
	lnAddress: string;
	/**
	 * NIP-57 recipient pubkey (hex) — the `p` tag zap requests carry and the
	 * `#p` filter zap receipts are matched on. This is the project's own
	 * identity, distinct from the LNURL host's `nostrPubkey` (which only signs
	 * receipts). npub1qc8quy6ah46k4q9es6fvjqjgk6rdv42cdsccnjhyx59j35n7azlq7ntwss
	 */
	recipientPubkey: string;
	/** Donation dialog title. */
	dialogTitle: string;
	/** Donation dialog description. */
	dialogDescription: string;
}

export type NewsFeedItemKind = 'release' | 'donation';

export interface NewsFeedItem {
	id: string;
	kind: NewsFeedItemKind;
	createdAt: number;
	title?: string;
	body: string;
	/** Present on `donation` items (default config merged with release overrides). */
	donation?: DonationConfig;
}

/**
 * Default donation configuration. Releases can selectively override any field.
 */
export const DEFAULT_DONATION: DonationConfig = {
	eyebrow: 'Support Cordn',
	body: 'Cordn is free and open source. If it has been useful, consider supporting its development.',
	ctaLabel: 'Donate',
	lnAddress: 'besao@coinos.io',
	recipientPubkey: '060e0e135dbd756a80b98692c90248b686d655586c3189cae4350b28d27ee8be',
	dialogTitle: 'Support Cordn',
	dialogDescription: 'Donations are made via Lightning zaps. Thank you for your support!'
};

/**
 * Authored releases. Replace and extend this array to publish announcements.
 */
export const newsReleases: NewsRelease[] = [
	{
		id: 'cordn-news-welcome',
		createdAt: Date.UTC(2026, 5, 24),
		title: 'Welcome to Cordn updates',
		body: 'This feed is where we will share release notes, new features, and product updates as Cordn evolves. Thanks for following along!'
	}
];

/**
 * Returns the feed items with a donation item (default config merged with any
 * release overrides) inserted right after each release, unless the release opts
 * out with `donation: false`.
 */
export function getNewsFeedItems(): NewsFeedItem[] {
	return newsReleases.flatMap((release) => {
		const items: NewsFeedItem[] = [
			{
				id: release.id,
				kind: 'release',
				createdAt: release.createdAt,
				title: release.title,
				body: release.body
			}
		];
		if (release.donation !== false) {
			const donation: DonationConfig = { ...DEFAULT_DONATION, ...release.donation };
			items.push({
				id: `${release.id}:donation`,
				kind: 'donation',
				createdAt: release.createdAt,
				body: donation.body,
				donation
			});
		}
		return items;
	});
}

export function getLatestNewsCreatedAt(): number {
	return newsReleases.reduce((max, release) => Math.max(max, release.createdAt), 0);
}
