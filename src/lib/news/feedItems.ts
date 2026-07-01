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
		id: 'cordn-news-2026-07-01-media',
		createdAt: Date.UTC(2026, 6, 1),
		version: 1,
		title: 'Send images and files in a group',
		body: '- ✨ Send images and files in a group — photos preview right in the chat and documents download with one tap, all encrypted end-to-end so only group members can open them.\n- ✨ Files appear the moment you send them and finish uploading in the background, so you can keep typing your next message right away.\n- 🔄 Pick where your shared media is stored under Config → Media; if a server is unreachable, uploads fall back to another one automatically.\n- ✨ Pin any message in a group. Pinned messages collect in a carousel at the top of the chat — click one to jump straight back to it, or open the full list to see them all and unpin.\n- ✨ Anyone in a group can pin and unpin, and each pin shows who pinned it.\n- 🐛 Names in profile cards no longer bleed across people when several appear together (for example in a thread or the pinned-messages list).'
	},
	{
		id: 'cordn-news-2026-06-30',
		createdAt: Date.UTC(2026, 5, 30),
		version: 1,
		title: 'See more about any message',
		body: '- ✨ A redesigned info panel for any message: it lays out the full conversation thread around it, who reacted and with what, and the message’s delivery and editing status — all in one place.\n- ✨ The info button now lives next to Reply and React on every message, so you no longer have to dig into the menu.\n- ✨ From the info panel, jump straight back to a message in the chat. On desktop the panel stays open beside the conversation; on mobile it closes so you land right on the message.\n- 🐛 When a message you replied to gets deleted or edited, its reply preview now shows the current state instead of the original text.'
	},
	{
		id: 'cordn-news-2026-06-29',
		createdAt: Date.UTC(2026, 5, 29),
		version: 1,
		title: 'Coordinator names, straight from the source',
		body: '- ✨ Coordinators now display the name their server advertises when available, with your custom label still taking priority. A coordinator’s page also shows its about text, website, and picture when the server provides them.\n- 🔄 Sending a message no longer waits on an unrelated coordinator that is having trouble — only the group you are messaging waits for its own coordinator, so healthy groups stay snappy when another one is slow to reconnect.\n- 🔄 The sidebar finishes loading sooner after sign-in: join requests and key packages no longer wait for every group subscription to finish opening.\n- 🐛 The New conversation dialog and chat home now show exactly the same key-package list — same coordinator filter, counts, and color coding — so the two can no longer drift apart after a refresh.\n- 🐛 The key packages settings page now stays in sync with the rest of the app — creating or removing a key package updates every list immediately instead of holding a stale snapshot.\n- 🐛 If you leave a group and request to join again, admins now see your request on the first send — previously you had to send it twice (or reset your request state) before it would appear.\n- 🐛 You no longer see your own join request in your notifications after being re-added to a group where every member is an admin.\n- 🐛 Stale join-request notifications for groups you no longer administer are cleaned up automatically.\n- 🐛 An admin can now accept a join request from someone who is still technically in the group — they are cleanly removed and re-added instead of the accept failing.'
	},
	{
		id: 'cordn-news-2026-06-28',
		createdAt: Date.UTC(2026, 5, 28),
		version: 1,
		title: 'Back up and recover your account',
		body: '- ✨ Back up and recover your account — export your private keys, group secrets, and coordinators from the new Backup & recovery page under Config, and restore them on a fresh device.\n- 🐛 Creating or restoring a large encrypted backup no longer freezes the app — the encryption now runs in the background, which is especially noticeable on mobile.\n- 🔄 Welcomes and join requests you have already accepted or dismissed no longer reappear on their next refresh.\n- 🐛 Fixed a crash on a coordinator’s page when the same key package showed up more than once.\n- 🔄 Key packages already used to join a group are now cleaned up automatically — group secrets are self-contained, so a used key package has no further purpose. Unused and still-published ones are never touched.\n- 🔄 The New conversation dialog now shows each coordinator by its saved label and color dot instead of the raw pubkey, and pre-fills the default coordinator for you.\n- ✨ Encrypted group payloads (experimental) — opt in from a group’s info page to seal your messages so the relaying coordinator only ever sees opaque bytes. Each participant turns it on for themselves; sealed and plaintext messages mix transparently while everyone catches up.\n- 🔄 A message’s info dialog now shows whether it was sent sealed or in plaintext, so you can confirm encrypted payloads are active in a group.'
	},
	{
		id: 'cordn-news-2026-06-26',
		createdAt: Date.UTC(2026, 5, 26),
		version: 4,
		title: 'Smoother coordinators and joining',
		body: '- ✨ You can now join a group by pasting its link or ID straight from the New conversation dialog — no need to edit the URL by hand. The same paste field lives in the Scan tab of any share or QR dialog.\n- 🐛 Group share links are more robust: names and icons survive every chat app and email without getting mangled, and one corrupted field no longer breaks the whole link.\n- 🔄 The key packages settings page now makes clear that removing a key package only affects new invitations — it does not affect groups you have already joined.\n- ✨ Group chats now show a scroll-to-bottom button when you have scrolled up, so you can jump back to the latest message in one click.\n- 🐛 Removing a coordinator that is offline is now instant — a leftover step was still checking every known coordinator and hanging on any that were offline.\n- 🔄 Coordinators are now saved automatically when you join a group or publish a key package — no separate "Save locally" step, and joining a group can no longer change your default coordinator.\n- ✨ The New conversation dialog and the key-package directory now show packages from coordinators you have joined without needing a manual save or a page refresh.\n- ✨ If a join request goes unanswered, you can now request again from the group page; sent requests clear automatically once you are added.\n- 🐛 Fixed coordinators you just joined sometimes connecting through a wrong local relay.'
	},
	{
		id: 'cordn-news-2026-06-25',
		createdAt: Date.UTC(2026, 5, 25),
		version: 2,
		title: 'Recent updates',
		body: "- 🔄 Removing a coordinator now deletes everything tied to it — groups, key packages, and welcomes — with a confirmation that reports what will actually be removed.\n- ✨ Coordinator and group cards gained a quick-actions menu, with delete available consistently across the sidebar, chat home, coordinator detail, and profile pages.\n- ✨ Adding a coordinator is easier: paste a hex pubkey, npub, or nprofile (relays autofill from nprofile), or open a share link with `?c=...`. Relay and color options fold under Advanced.\n- 🔄 Gave the supporters drawer more padding so cards and amounts are not cramped against the screen edge.\n- 🔄 Long donation messages now expand when you click them, instead of being trimmed off.\n- 🐛 Requesting to join a group now uses a key package published to that group's coordinator, fixing cross-coordinator joins that failed with \"key package ref doesn't exist.\"\n- 🔄 Join requests and the directory key-package button now create last-resort packages by default, so they can't be consumed before a welcome arrives.\n- 🐛 Share links with a malformed coordinator no longer silently fall back to the default coordinator — only links with no coordinator at all do.\n- 🐛 Starting a direct message from a profile no longer changes your default coordinator.\n- ✨ Creating a key package now shows a confirmation toast.\n- ✨ The key-package directory filters by coordinator, color-codes each package by its coordinator, and shows a live count including how many are yours.\n- 🔄 The directory now refreshes automatically after you create or remove a key package.\n- 🐛 Deleting a coordinator that's offline no longer hangs waiting for it — key packages are cleaned up locally instead of waiting on the network."
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
