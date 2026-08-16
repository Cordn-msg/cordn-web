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
		id: 'cordn-news-2026-08-04-multi-device-reliability',
		createdAt: Date.UTC(2026, 7, 4),
		version: 1,
		title: 'More reliable multi-device messaging',
		body: "- 🐛 Messages from a linked device that was briefly offline or in the background no longer fail to decrypt on your other devices — each device now makes sure it is fully caught up before sending.\n- 🐛 Messages that arrive while one of your devices is still catching up are now recovered once it does, instead of being silently skipped.\n- 🔄 If a linked device's state ever drifts out of sync, the group now repairs itself instead of every message from that device failing until you fix it by hand."
	},
	{
		id: 'cordn-news-2026-07-24-links-invites',
		createdAt: Date.UTC(2026, 6, 24),
		version: 1,
		title: 'Friendlier links and more reliable invites',
		body: '- ✨ Profile links now accept NIP-05 addresses (like user@domain) and bare cordn.net shortnames alongside hex, npub, and nprofile, so you can link to a profile with whichever identifier you have.\n- ✨ New sign-ups get a "Join Cordn group" button on chat home to hop straight into the official discussion group.\n- 🔄 When the native app is installed, cordn.net chat and profile links now open it directly instead of showing an app chooser.\n- 🔄 Inviting members to a new group now sends each invite on its own, so one unreachable key package no longer aborts the rest — anything that fails surfaces as a toast.\n- 🐛 Reloading a group right after inviting someone no longer drops the invite: pending add-member operations are now saved and reapplied on the next open.\n- 🐛 A message you send no longer pings a notification on your own other devices.\n- 🔄 On mobile web, the on-screen keyboard no longer slides over the message composer.\n- 🔄 The news feed\'s unread marker is now a quiet red dot, matching the rest of the app\'s attention cues.'
	},
	{
		id: 'cordn-news-2026-07-23-multi-file-uploads',
		createdAt: Date.UTC(2026, 6, 23),
		version: 1,
		title: 'Send several files at once',
		body: "- ✨ Add several photos or documents to a message and send them together — each uploads and sends on its own, so one large file never holds up the rest.\n- ✨ Uploads now show real progress as bytes leave your device, with a spinner while connecting and finishing, so a big file is clearly on its way instead of sitting at a static preview.\n- ✨ Cancel any upload with one tap — on a photo's corner or beside a file — and it clears right away if you change your mind.\n- 🐛 A media message that failed to send no longer retries as an empty message; tap to remove it and pick the file again."
	},
	{
		id: 'cordn-news-2026-07-22-live-connection-resilience',
		createdAt: Date.UTC(2026, 6, 22),
		version: 1,
		title: 'Live chats recover on their own',
		body: '- 🔄 Returning to the app after it was in the background now restores your live chats on every device — until now this recovery only ran on mobile, so a backgrounded desktop tab could silently stop receiving new messages until you refreshed.\n- 🐛 When a live connection dies while the app is backgrounded, returning now rebuilds it for you instead of leaving it quiet — anything you missed is pulled in at the same time.\n- 🐛 A live connection the coordinator closed on its own no longer leaves a group silently stuck with no new messages until you switched away and back; it restarts on its own.'
	},
	{
		id: 'cordn-news-2026-07-16-multi-device',
		createdAt: Date.UTC(2026, 6, 16),
		version: 1,
		title: 'Multi-device sync',
		body: "- ✨ Link your devices and your groups stay in sync across all of them: join or create a group on one device and it appears on the others automatically, and removing a group from your list removes it everywhere.\n- 🔄 To turn it on, go to Config → Multi-device sync and follow the steps to link your devices with a connection string. It's entirely opt-in, so nothing changes if you don't want it.\n- 🔄 Once linked, sync runs quietly in the background over Nostr and Blossom, with nothing to manage.\n- ✨ A message that failed to send now shows a retry button, so you can resend it with one tap instead of retyping it.\n- ✨ When publishing your key package, if a coordinator already holds a conflicting one (for example from another device), you're now asked how to proceed instead of a silent conflict."
	},
	{
		id: 'cordn-news-2026-07-04-reconnect-resilience',
		createdAt: Date.UTC(2026, 6, 4),
		version: 1,
		title: 'Smoother catch-up and reconnections',
		body: '- 🐛 Chats now catch up reliably when you return to the app on mobile — if the live connection went quiet while you were away, anything you missed is pulled in automatically instead of waiting for the next new message to arrive.\n- 🔄 Coordinator blips like timeouts or brief disconnects recover faster and more quietly: retries now back off and only the affected coordinator is touched, so a flaky connection no longer disrupts healthy chats.\n- 🐛 A silently dropped connection no longer leaves a group stuck unwatched until you switch away and back — it now recovers on its own.\n- 🔄 First actions after reopening the app on mobile are less likely to trip a signer error: the wake-up window is longer and gentler.'
	},
	{
		id: 'cordn-news-2026-07-03-sealed-default',
		createdAt: Date.UTC(2026, 6, 3),
		version: 2,
		title: 'Sealed by default',
		body: '- 🔄 Group messages are now sealed by default — the coordinator relaying them only ever sees opaque bytes, with no opt-in or setup. Sealed and plaintext messages still mix transparently while everyone in a group updates.\n- 🐛 When you accept a welcome or join request, the coordinator is notified right away, so other admins stop seeing a request you have already handled instead of waiting for the next refresh.\n- 🐛 Group avatars no longer show as an empty disc when "autoload media" is off: they fall back to the group\'s icon, or the Cordn logo when neither an image nor an icon is set.\n- 🐛 Switching between groups now shows each group\'s icon in the chat header right away, instead of it sometimes staying hidden until you navigated in and out a few times.'
	},
	{
		id: 'cordn-news-2026-07-02-media-view',
		createdAt: Date.UTC(2026, 6, 2),
		version: 1,
		title: 'Tap, zoom, and play shared media',
		body: '- ✨ Tap any image to open it full-screen — zoom in or out (even past 100%), drag to pan, double-tap to fit, and save a copy. It works on images sent as attachments and on image links pasted into a message.\n- ✨ Image and video links pasted in a chat now appear inline as a preview you can open and play without leaving the conversation.\n- ✨ Config → Media now also lets you choose whether images and avatars should load automatically — handy on a metered connection — alongside where shared media is stored.\n- 🐛 Shared images and files now send reliably: a hidden failure was rejecting some uploads (photos sent with no caption were the common case), the server list was refreshed to known-good servers, and uploads now verify nothing was altered in transit so encrypted media can\'t arrive corrupted.\n- 🐛 Media you\'ve opened stays put when you scroll away and come back, and links, mentions, and previews now render in the message info panel just like in the chat.\n- 🔄 Avatars and banners now follow your "load avatars" choice everywhere — chat bubbles, profile cards, and the group and direct-message list all stay in sync.\n- ✨ Download any shared file or image straight from its message menu.'
	},
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
		id: 'cordn-news-2026-08-16-reconnect-calm',
		createdAt: Date.UTC(2026, 7, 16),
		version: 2,
		title: 'Quieter, steadier reconnections',
		body: '- 🐛 One hiccup no longer snowballs: when a chat connection drops, it is rebuilt exactly once — the echoes of the old connection failing were previously mistaken for new failures, triggering a chain of unnecessary rebuilds that could briefly disturb healthy chats.\n- 🔄 The keepalive that proves a live chat connection is alive now tolerates one slow relay hop, so a momentarily laggy relay no longer restarts an otherwise healthy connection.\n- 🔄 Connecting to a coordinator is now bounded: a server that never answers is cut and retried cleanly instead of leaving the handshake hanging indefinitely.\n- 🔄 Dropping a connection now properly cancels the network retries it had in flight, so unreachable relays no longer leave a trail of background retries behind.\n- ✨ The "make yourself reachable" banner can now be dismissed, so it no longer lingers if you would rather not publish a key package yet.\n- 🔄 Media uploads now default to a more reliable storage server; the previous default had become flaky and stays available as a fallback.'
	},
	{
		id: 'cordn-news-welcome',
		createdAt: Date.UTC(2026, 5, 24),
		version: 1,
		align: 'center',
		title: 'Welcome to Cordn updates',
		body: 'This feed is where we will share release notes, new features, and product updates as Cordn evolves. Thanks for following along!'
	},
	{
		id: 'cordn-news-2026-07-23-native-android',
		createdAt: Date.UTC(2026, 6, 23),
		version: 1,
		title: 'Cordn native Android app is here',
		body: "The native Cordn app is now available on [ZapStore](https://zapstore.dev/apps/naddr1qqxk7un89e3k7unydchxzursqyv8wumn8ghj7un9d3shjtn6v9c8xar0wfjjuer9wcpzps7xmxansh7cyl8ak3wexws73n8jjpd7xpr8z50dtl34dgg22f0fqvzqqqr7pv6zvfm6). This has been a long-requested feature, and it is finally here for everyone.\n\nThe headline reason to install it: **push notifications.** You no longer have to keep a tab open or keep checking the app to stay on top of your groups. And for the nerds — there is no third-party push server and no notification service sitting in the middle. Everything runs on your phone through efficient coordinator fetching, so this is as private and secure as the rest of Cordn.\n\nIt also ships with:\n\n- ✨ **Amber login**, alongside every other login method Cordn already supports, so you can sign in with your preferred Nostr signer.\n- ✨ A **share intent handler**, so sharing a link, image, or piece of text straight into a Cordn group is now a single tap from anywhere on your phone.\n\nPrefer the web or a PWA? Nothing changes — you can keep using Cordn in the browser or installed as a PWA exactly as before. The native app is an addition, not a replacement, and it is what finally unblocks reliable notifications, a real requirement these days to not lose a beat in your groups.\n\nThis is the first official release and the first milestone in Cordn's native evolution. We tried our best to iron out every bug and edge case, but this is software, so please report anything you find. Feature requests are welcome too, and the full release notes live at [cordn.net/chat/news](https://cordn.net/chat/news).\n\nNot using Cordn yet? [Start chatting](https://cordn.net/). If you like the project and want to see it grow, consider contributing in any way you can — report a bug, contribute your expertise, send some sats. We are building this together in the open 💛"
	},
	{
		id: 'cordn-news-2026-08-05-native-keyboard',
		createdAt: Date.UTC(2026, 7, 5),
		version: 1,
		title: 'A smoother keyboard on Android',
		body: '- 🐛 The on-screen keyboard no longer covers the message bar in the native Android app — it lifts the composer into view and keeps the newest messages visible above it instead of hiding them behind it.\n- 🐛 Opening a chat no longer brings up the keyboard on its own — it only appears when you tap to reply or edit.\n- 🐛 The keyboard stays open after you send a message, so you can fire off the next one without re-tapping.\n- 🔄 The native app now fits your screen edge-to-edge — content clears the status bar, notch, and home indicator — and drops the web-style tap flash and overscroll bounce for a more native feel.'
	},
	{
		id: 'cordn-news-2026-08-06-notifications',
		createdAt: Date.UTC(2026, 7, 6),
		version: 1,
		title: 'Less notification clutter',
		body: '- 🐛 Reading a message by opening Cordn — instead of tapping its notification — no longer leaves the notification lingering behind. Opening the app now clears your message notifications on both desktop and Android, the same as tapping one would.\n- 🔄 On desktop, Cordn no longer shows notifications while you are already looking at it — the in-app unread badge already shows what is new, so there is less noise while you have the app in focus.'
	},
	{
		id: 'cordn-news-2026-08-09-avatar-profile-link',
		createdAt: Date.UTC(2026, 7, 9),
		version: 5,
		title: 'Jump to a profile from the chat',
		body: "- ✨ Tap a member's avatar in a group chat to open their profile, where you can see their details and start a direct chat with them.\n- 🐛 On Android, pressing back now closes an open group list, dialog, or image instead of jumping out of the chat behind it.\n- ✨ Videos shared in a chat now play inline — tap to watch right in the conversation instead of getting a share sheet.\n- 🐛 Sending a video no longer uploads it twice on some servers: Cordn learns which storage server silently alters uploads and skips it afterward, so each file is sent once.\n- 🔄 Uploads are smoother — one continuous progress bar with a clear status (connecting, finishing, retrying) replaces the old jump between a bar and a spinner, and the chat no longer flickers while a photo or video uploads.\n- 🐛 A message's action buttons (reply, react, info) now close when you tap anywhere else, instead of hovering over the chat until you pick one — and they no longer overlap neighbouring messages or steal their taps.\n- 🔄 On a long message, those buttons now appear at whichever end you are looking at, so you no longer have to scroll up to the top to reach them.\n- ✨ The native Android app now lets you know when a new version is out: it checks Zapstore and shows a banner so you can update in one tap instead of running an older build."
	},
	{
		id: 'cordn-news-2026-08-08-group-refs',
		createdAt: Date.UTC(2026, 7, 8),
		version: 1,
		title: 'Portable group links',
		body: "- ✨ Group invites and share links now use the standard cordn1 format: the coordinator and relay hints are packed right into the link, so the same invite opens correctly no matter which Cordn client or coordinator setup receives it.\n- ✨ Paste a cordn1… group reference (or a cordn.net link) straight into a chat and it opens the group inside Cordn, instead of a blank tab.\n- 🐛 Pasting a full group link that carries a name and icon preview into the join box no longer glues that metadata into the group's address — the link now resolves cleanly.\n- 🔄 Links everywhere — the sidebar, message permalinks, and profile pages — now use the portable cordn1 form, so a group's link stays consistent wherever you copy or share it from."
	},
	{
		id: 'cordn-news-2026-08-10-voice-notes',
		createdAt: Date.UTC(2026, 7, 10),
		version: 1,
		title: 'Send voice notes in a chat',
		body: '- ✨ Hold the mic button to record a voice message, then release to send it — handy when you’d rather talk than type.\n- ✨ While holding, drag up to keep recording hands-free (then tap send or discard), or drag left to cancel.\n- ✨ Voice notes play right in the conversation with a waveform and timer — tap the bar to jump to any moment.\n- 🔄 Like everything else, voice notes are encrypted end-to-end and respect your media autoload setting.'
	},
	{
		id: 'cordn-news-2026-08-15-ui-refresh',
		createdAt: Date.UTC(2026, 7, 15),
		version: 2,
		title: 'A cleaner, calmer chat app',
		body: '- ✨ Chat home has a fresh, focused layout: clear tiles to start a chat, check notifications, share your profile, or open settings — and your chats below them, with the news feed sitting in the list like any other conversation instead of being pinned on top.\n- 🔄 The sidebar is now one simple list of your chats, most recent first, with a small colored dot marking which coordinator hosts each group.\n- ✨ Fold the quick actions out of the way on chat home and in the sidebar — a quiet red dot on the toggle lets you know when an invitation needs your attention while they are hidden, and each spot remembers whether you left it open or closed.\n- 🔄 Creating a group is one simple form — name, picture, and members first — while coordinator and key-package details wait under Advanced until you want them.\n- 🔄 The New conversation dialog is tidier, and its join field stays hidden behind a "Join group" toggle until you need it.\n- 🔄 Inviting someone to a group now uses the same searchable people directory as starting a new conversation.\n- 🔄 Clearer words throughout: welcomes are "invitations" you accept or decline, Config is now Settings, and the theme toggle lives in the Settings header.\n- ✨ Mark any chat as read right from its sidebar menu, and an empty conversation greets you with a friendly "No messages yet — say hi 👋".\n- ✨ First visit is calmer: before you log in, the app shows just a welcome and one "Get started" step — and it opens on the easiest way in for you (create a key, your browser extension, or a signer app).\n- 🔄 On the web, a one-time notice explains that your chats live in this browser\'s storage, with a shortcut to back them up.\n- 🐛 On Android, the app no longer crashes right after the phone restarts.\n- 🐛 On Android, saving a backup no longer crashes the app — large backups are written straight to the location you pick.\n- 🐛 Returning from the background no longer risks a stuck "Updating chats…" bar — stalled recovery now rebuilds your chat connections from scratch within seconds, and messages you missed while away are pulled in on recovery.\n- 🐛 A fresh app open no longer shows false connection warnings while your Nostr wallet extension is still waking up.'
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
