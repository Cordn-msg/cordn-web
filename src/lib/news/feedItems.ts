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
 * The feed sorts releases ascending by day (oldest at the top, newest at the
 * bottom — like chat messages), so authors can append in any order; within a
 * day, array order is preserved (stable sort). Use a Markdown bullet list
 * (`- `) to accumulate multiple same-day changes as dots in one card. */

export interface NewsRelease {
	id: string;
	createdAt: number;
	title: string;
	/** Markdown body. */
	body: string;
	/** Release body alignment. Defaults to `left`; `center` suits short greetings. */
	align?: 'left' | 'center' | 'right';
	/**
	 * Unread-tracking version. Bump when you edit an already-published release
	 * so readers who saw the previous version are re-notified. `createdAt` is
	 * left alone (keeps the day label stable); only `version` signals "this
	 * changed". Defaults to 1. Supports multiple same-day edits.
	 */
	version?: number;
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
	/** Unread version for releases; `0` for donation items (never unread). */
	version: number;
	title?: string;
	body: string;
	/** Release body alignment. Inherited from the release; undefined on donations. */
	align?: 'left' | 'center' | 'right';
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
		id: 'cordn-news-2026-06-25',
		createdAt: Date.UTC(2026, 5, 25),
		version: 1,
		title: 'Recent updates',
		body: "- Removing a coordinator now deletes everything tied to it — groups, key packages, and welcomes — with a confirmation that reports what will actually be removed.\n- Coordinator and group cards gained a quick-actions menu, with delete available consistently across the sidebar, chat home, coordinator detail, and profile pages.\n- Adding a coordinator is easier: paste a hex pubkey, npub, or nprofile (relays autofill from nprofile), or open a share link with `?c=...`. Relay and color options fold under Advanced.\n- Gave the supporters drawer more padding so cards and amounts are not cramped against the screen edge.\n- Long donation messages now expand when you click them, instead of being trimmed off.\n- Requesting to join a group now uses a key package published to that group's coordinator, fixing cross-coordinator joins that failed with \"key package ref doesn't exist.\"\n- Join requests and the directory key-package button now create last-resort packages by default, so they can't be consumed before a welcome arrives.\n- Share links with a malformed coordinator no longer silently fall back to the default coordinator — only links with no coordinator at all do.\n- Starting a direct message from a profile no longer changes your default coordinator.\n- Creating a key package now shows a confirmation toast.\n- The key-package directory filters by coordinator, color-codes each package by its coordinator, and shows a live count including how many are yours.\n- The directory now refreshes automatically after you create or remove a key package."
	},
	{
		id: 'cordn-news-welcome',
		createdAt: Date.UTC(2026, 5, 24),
		version: 1,
		align: 'center',
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
	return [...newsReleases]
		.sort((a, b) => a.createdAt - b.createdAt)
		.flatMap((release) => {
			const items: NewsFeedItem[] = [
				{
					id: release.id,
					kind: 'release',
					createdAt: release.createdAt,
					version: release.version ?? 1,
					title: release.title,
					body: release.body,
					align: release.align ?? 'left'
				}
			];
			if (release.donation !== false) {
				const donation: DonationConfig = { ...DEFAULT_DONATION, ...release.donation };
				items.push({
					id: `${release.id}:donation`,
					kind: 'donation',
					createdAt: release.createdAt,
					version: 0,
					body: donation.body,
					donation
				});
			}
			return items;
		});
}
