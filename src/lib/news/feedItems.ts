/**
 * Static, build-time news feed for Cordn.
 *
 * News is a global, read-only broadcast — not an MLS group. Releases are
 * authored in the `newsReleases` array below; each release is automatically followed by a
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
const newsReleases: NewsRelease[] = [
	{
		id: 'cordn-news-2026-11-08-inside-bubble-metadata',
		createdAt: Date.UTC(2026, 10, 8),
		version: 1,
		title: 'Timestamps move inside the bubble',
		body: '- ✨ Message time, pin and delivery state now sit in a quiet row inside the bubble, right-aligned — and they no longer get swept along when you select and copy message text.\n- 🔄 Your own messages no longer show your own picture: a right-aligned bubble already says it’s you.'
	},
	{
		id: 'cordn-news-2026-11-08-highlight-sources-pr-cards',
		createdAt: Date.UTC(2026, 10, 8),
		version: 1,
		title: 'Highlights tell you where they came from — and pull requests arrive as cards',
		body: '- ✨ A nostr highlight now lists every source it was made from, and a nostr article source is labelled with the article’s real title instead of a generic link.\n- 🔄 When the original passage is available, the quote sits emphasised inside it with the surrounding text dimmed, instead of a separate line below.\n- ✨ Paste a nostr pull request link and it renders as a proper card: repository, branches, commit, labels and description, with a copy-clone-URL action in its menu.'
	},
	{
		id: 'cordn-news-2026-10-30-multi-device-convergence',
		createdAt: Date.UTC(2026, 9, 30),
		version: 1,
		title: 'Coordinator deletions stick, and linked devices settle down',
		body: '- 🐛 Removing a coordinator now stays removed across your linked devices: its groups and publishing claim are retracted together instead of being restored by the next sync.\n- 🐛 Linked devices no longer bounce unchanged encrypted documents back and forth, so multi-device sync settles instead of repeatedly uploading every group.\n- ✨ Multi-device Advanced settings now accepts your own Blossom document hosts, and the settings page no longer freezes when custom hosts are present.\n- ✨ A new Activity log under Advanced → Dev mode records what sync is doing and keeps it across restarts. Copy log puts the full diagnostic history on your clipboard.'
	},
	{
		id: 'cordn-news-2026-10-26-live-reactions',
		createdAt: Date.UTC(2026, 9, 26),
		version: 1,
		title: 'Reactions that show up on time — in a chat that holds still',
		body: "- 🐛 Reactions, edits and pins on the newest message now appear the moment they happen — until now you had to leave the group and come back to see them.\n- 🐛 The conversation no longer jumps when a reaction makes a message taller: the view stays put while you're at the latest messages.\n- 🐛 A sender's picture no longer goes missing when the last line under their message is a small reaction note.\n- 🔄 Messages still on their way out no longer offer reactions and edits — tapping there used to do nothing at all."
	},
	{
		id: 'cordn-news-2026-10-26-nostr-highlights',
		createdAt: Date.UTC(2026, 9, 26),
		version: 1,
		title: 'Nostr highlights, quoted right',
		body: '- ✨ Paste a nostr highlight link into a chat and it now arrives as a proper quote card: the highlighted passage, any comment the highlighter added, and a tap-through to where it came from.\n- 🔄 Embedded nostr posts of every kind show their content now — whatever you paste renders as more than an empty card with a kind number on it.'
	},
	{
		id: 'cordn-news-2026-10-26-attachment-captions',
		createdAt: Date.UTC(2026, 9, 26),
		version: 1,
		title: 'A caption for every photo',
		body: "- ✨ Attach several photos at once and each one can carry its own words: tap a photo's chip before sending to write its caption, flip through the rest with the arrows, and every photo goes out with its caption under it. The message box still captions the first photo, exactly as before."
	},
	{
		id: 'cordn-news-2026-10-21-quiet-fixes',
		createdAt: Date.UTC(2026, 9, 21),
		version: 1,
		title: 'Quiet fixes: polls, broken media and notification jumps',
		body: "- 🐛 Opening a poll's details now shows its reactions and exactly who reacted, just like text messages always did.\n- 🐛 Messages with old, dead media links no longer flash a loading spinner in an endless loop — they settle on a “Couldn't load media” note you can tap to try again.\n- 🐛 Opening a chat from a notification stays where it lands: the view no longer slides up into older messages a moment after arriving at the new ones.\n- 🐛 Returning to your chat list no longer blinks 1:1 avatars — the other person's picture is there right away."
	},
	{
		id: 'cordn-news-2026-10-15-typing-jump',
		createdAt: Date.UTC(2026, 9, 15),
		version: 1,
		title: 'A chat that holds still while you type',
		body: '- 🐛 Another pass at the jumpy chat: writing a message that wraps to several lines no longer makes the conversation jump on every keystroke or line break. The view stays pinned to the newest message while you write, and typing no longer stirs up a storm of background work that made long chats feel heavy.'
	},
	{
		id: 'cordn-news-2026-10-15-poll-question-media',
		createdAt: Date.UTC(2026, 9, 15),
		version: 1,
		title: 'Pictures and links in poll questions',
		body: "- ✨ A poll question is no longer just plain text: paste an image or video link into it and it shows right in the poll card, in the chat and in the poll's details. Links and @mentions work there too, and pasted media follows your auto-load media setting like everywhere else — tap “Load media” to reveal it when loading is off."
	},
	{
		id: 'cordn-news-2026-10-15-reachability',
		createdAt: Date.UTC(2026, 9, 15),
		version: 1,
		title: 'Reachable everywhere, automatically',
		body: "- ✨ You now stay reachable everywhere automatically: Cordn keeps your key package — the contact card that lets people start a private conversation with you — published on every coordinator you use, so people there can always invite you. The “Keep me reachable automatically” switch in Settings → Key packages is on by default; turn it off if you prefer to publish only when you ask.\n- 🐛 The “You're not reachable” notice used to go quiet as soon as any one coordinator had your key package, even when the others had none — people there could not reach you. It now speaks up only after actually checking, and names exactly the coordinators where you are missing.\n- 🔄 “Make me reachable” fixes every listed coordinator in one tap, and never overwrites a key package published from another of your devices."
	},
	{
		id: 'cordn-news-2026-10-13-polls',
		createdAt: Date.UTC(2026, 9, 13),
		version: 1,
		title: 'Ask the group: polls are here',
		body: "- ✨ Press + next to the message box and choose Poll to ask the group anything: write a question, add two to ten options, decide whether people pick just one or as many as they like, and set an end time — from an hour up to a week, or no deadline at all.\n- ✨ Voting is one tap on an option, and the poll fills in its own results as they come in: every option grows a bar with its count, and opening the poll's details shows exactly who picked what.\n- 🔄 Changed your mind? Tap a different option while the poll is open — your latest pick is the one that counts, one vote per person. When the deadline passes, the poll marks itself closed and its options lock."
	},
	{
		id: 'cordn-news-2026-10-13-search-people-and-groups',
		createdAt: Date.UTC(2026, 9, 13),
		version: 1,
		title: 'Search people and groups, and quieter reactions',
		body: "- ✨ Search is no longer just for messages: type a person's name to jump to their profile, a group title to open the chat, or message text as before — all from one box. It is in the sidebar and at the top right of the Chats screen, and inside an open chat it narrows down to just that chat.\n- ✨ The share picker has a search bar of its own: type a group title or a person's name to narrow the list before sharing.\n- 🐛 Pinned groups stay on top in the share picker and in search results, the same as in the chat list.\n- 🐛 Reaction lines in the chat now tell you about other people: your own reactions no longer show up as lines (they still appear on the message itself), and one person's burst of reactions collapses into a single line you can open to see each reaction and jump to the message it is about."
	},
	{
		id: 'cordn-news-2026-10-13-reliable-notifications',
		createdAt: Date.UTC(2026, 9, 13),
		version: 1,
		title: 'Notifications that keep coming, and a steadier chat',
		body: "- 🐛 Notifications arrive more reliably on Android. Many phones pause apps in the background to save battery, and that is what made Cordn's notifications stop or come late. Cordn now asks just once, at launch, for permission to keep running in the background — answering “Allow” is all it takes. You can still change your mind later in Settings → Notifications.\n- ✨ If notifications are turned on but that background permission is still missing, a small reminder now appears above your chats. Tap “Allow background” to fix it in one step, or dismiss the reminder once and it never comes back.\n- 🐛 Writing a message with several lines no longer makes the chat above jump around as you type.\n- 🐛 Sharing into a group and pressing back no longer bounces you between the “Share to…” screen and the chat over and over — back now leaves the app, like you expect.\n- 🐛 The image preview on desktop is usable again: the zoom buttons zoom instead of closing the preview, and clicking the photo no longer closes it either."
	},
	{
		id: 'cordn-news-2026-10-13-safe-edits',
		createdAt: Date.UTC(2026, 9, 13),
		version: 1,
		title: 'Edits stay edits, online or offline',
		body: '- 🐛 Editing a message while picking a mention used to send the edit out as a brand-new message instead of editing — the edit stays an edit now, even when the app redraws the chat mid-composition.\n- 🐛 A mention picked from the list is no longer dropped on its way out: it arrives as a proper @name in the message, whether you are sending or editing.\n- ✨ Edits now travel like your messages: edit while offline or when a send fails, and the change waits safely in the outbox with the usual delivery clock — one tap retries, and it lands as soon as you are back online.'
	},
	{
		id: 'cordn-news-2026-10-12-coordinator-relay-refresh',
		createdAt: Date.UTC(2026, 9, 12),
		version: 4,
		title: 'Chats recover on their own, and sharing tells you who can reach you',
		body: "- ✨ The servers that carry your groups — coordinators — can change address. Until now the app kept knocking on the old door and those groups stayed quiet until you noticed and fixed it by hand. Cordn now checks about once a day whether a coordinator announced a new address — and sooner when one stops answering — and switches over by itself the moment the new address is confirmed to work. No action needed: messages just flow again.\n- ✨ The share dialog now tells you whether people can actually reach you from the link you are about to share: each profile link shows if a key package is published on its coordinator, so you never hand out a QR code that leads to a dead end.\n- ✨ When you are not reachable yet, one tap on “Make me reachable” publishes a key package right from the share dialog — the same action as the callout on chat home.\n- 🔄 Starting a chat from someone's profile now says “Checking availability…” while it looks for their key package, instead of a button that gives no clue what is happening.\n- 🐛 Replies keep their quotes: replying to a photo or voice note now shows what you replied to instead of a blank line, a quoted message that isn't loaded shows “Message unavailable” instead of the whole quote vanishing, and a failed photo or video send no longer drops the reply when you send it again — and switching to another chat and back keeps the reply you armed.\n- 🐛 Editing gets honest about timing: the Edit action now appears only once your message is actually sent — it used to show up right away and do nothing, so if you gave up and typed the message again you ended up with the same text twice — and a reply's quote follows your edit immediately instead of lagging behind."
	},
	{
		id: 'cordn-news-2026-10-07-gif-picker',
		createdAt: Date.UTC(2026, 9, 7),
		version: 1,
		title: 'Say it with a GIF',
		body: '- ✨ A GIF is one tap away: press the + next to the message box, choose GIF, and search the gallery — words in any language or an emoji like 😂 both work. Tap a GIF and it drops into your message, ready to send on its own or with a caption, and plays right in the chat. (GIFs come from nostr.build — the credit line in the gallery links to them.)\n- 🔄 GIFs follow your media auto-load setting: if you keep images behind a “Load media” tap for privacy or data, GIFs wait for it too.'
	},
	{
		id: 'cordn-news-2026-10-07-notification-first-unread',
		createdAt: Date.UTC(2026, 9, 7),
		version: 1,
		title: 'Opening a chat from a notification lands on the new messages',
		body: '- 🐛 On Android, tapping a notification used to drop you at the very bottom of the conversation and quietly mark everything as read on the way — the unread marker and the missed-messages badge were gone before you saw a thing. Tapping now opens the chat at the first unread message, exactly like opening it from the list.'
	},
	{
		id: 'cordn-news-2026-10-07-staircase-links',
		createdAt: Date.UTC(2026, 9, 7),
		version: 1,
		title: 'Cordn links now open in Staircase too',
		body: '- ✨ Staircase, an independent Android app for Cordn, can now open cordn.net group and profile links. If you have both apps installed, Android asks which one to use — pick “Always” once to make the question go away. If Cordn is your only app, nothing changes: links keep opening Cordn directly.'
	},
	{
		id: 'cordn-news-2026-10-07-performance',
		createdAt: Date.UTC(2026, 9, 7),
		version: 1,
		title: 'Typing and scrolling are smooth again, even in big chats',
		body: '- 🐛 Some phones felt sluggish after the last update: typing could stutter and long chats scrolled unevenly — the more history a chat had behind it, the worse it got. That is fixed: typing and scrolling stay smooth no matter how far back a chat goes.\n- 🔄 Opening a chat with a long history is quicker now, and the app handles its message history far more efficiently behind the scenes — same messages, same unread counts, same search, just lighter on your phone.'
	},
	{
		id: 'cordn-news-2026-10-07-mentions-and-video',
		createdAt: Date.UTC(2026, 9, 7),
		version: 1,
		title: 'Mentions in captions and calmer video playback',
		body: '- 🐛 Mentioning someone in the caption of a photo, video, or voice note finally works like a mention anywhere else: it shows as a proper @name chip and notifies the person you mentioned — before, it silently arrived as plain text and never pinged them.\n- 🐛 On Android, tapping play or pause on a video no longer pops the keyboard up over it — the composer stays quiet while you watch. Scrubbing or long-pressing a video no longer drags the message around or opens its actions by accident, either.\n- 🐛 The reply and edit previews in the composer now show @name for mentions instead of raw Nostr codes.'
	},
	{
		id: 'cordn-news-2026-10-06-invite-cards',
		createdAt: Date.UTC(2026, 9, 6),
		version: 1,
		title: 'Invite links now open as cards inside chats',
		body: '- ✨ Paste a Cordn link — a group, a coordinator, or a profile — into a message and it arrives as a card instead of a wall of letters: the group’s name and its icon, whether you’re already in it, and one button to join or open the chat. The long link itself leaves the message text; Copy link and Show link are on the card for the raw form.\n- 🔄 The icon a link carries is shown as-is (usually an emoji), and when a link carries none, the Cordn logo stands in — never a broken image. A card with no room for a description skips the filler line, and revealing the raw link no longer stretches the message bubble sideways.'
	},
	{
		id: 'cordn-news-2026-10-06-chat-reliability',
		createdAt: Date.UTC(2026, 9, 6),
		version: 1,
		title: 'A steadier chat: videos, replies, unread marks, and stuck messages',
		body: '- 🐛 Videos no longer stop and restart whenever a message lands in any conversation — playback keeps going through new arrivals.\n- 🐛 Opening a group used to mark its whole history as read, even the parts you never scrolled to. Now only what you actually see counts as read, so the unread marker is still where you left it when you come back.\n- 🐛 A reply you were writing could silently disappear when messages arrived mid-sentence — and then send as a plain message with no reply attached. That window is closed.\n- 🐛 A message could sit behind the clock icon forever after a coordinator hiccup, surviving restarts, with no way to remove it. The app now re-checks on its own and recovers as soon as the coordinator answers — and while a message waits, the clock says why. If you ever want out, deleting a waiting message now simply works.\n- 🔄 The group menu’s delete option reads plainly “Delete group” — the confirmation dialog explains what stays untouched elsewhere.'
	},
	{
		id: 'cordn-news-2026-10-05-message-recovery',
		createdAt: Date.UTC(2026, 9, 5),
		version: 1,
		title: 'Disappearing messages — fixed, and the lost ones are back',
		body: '- 🐛 Messages could vanish for good: a message sealed moments before one of your linked devices changed the group — a rename, an invite — arrived while the app could not yet open it, and was skipped instead of waited for. The app now keeps the keys that open exactly those in-between messages, so what arrives late still opens.\n- 🐛 If messages already disappeared for you on an earlier version, they are not gone: after this update, the first sync re-fetches what was skipped and puts it back in the conversation where it belongs — once, quietly, in the background.\n- 🐛 Two devices changing a group at the same moment no longer ends in a wedge or a ghost list of kicked members: the device whose change lost the race now undoes it cleanly, catches up, and carries on. And inviting someone whose identity keys are stale is refused with a clear message instead of quietly corrupting the group.\n- 🐛 Your groups and history now survive the app being thrown out of memory: some sessions could silently fail to save to the device database, losing that session’s messages and changes on restart. Saving is hardened and no longer fails silently.\n- 🔄 Linked devices hold steady on flaky connections: retries and re-checks around multi-device syncing mean a dropped connection no longer means a lost change — and the encrypted documents your devices share are now checked against their own fingerprint at every step, never taken on a host’s word.'
	},
	{
		id: 'cordn-news-2026-10-05-profile-start',
		createdAt: Date.UTC(2026, 9, 5),
		version: 1,
		title: 'Starting a chat from a profile just works',
		body: '- 🐛 Starting a conversation from someone’s profile could wait twenty seconds and then give up with no way to try again — even while the coordinator was up. The list of reachable people now appears the moment you log in and is remembered on return, a Retry button actually probes instead of dead-ending, and starting takes far fewer round trips before the first message.'
	},
	{
		id: 'cordn-news-2026-10-02-composer-paste',
		createdAt: Date.UTC(2026, 9, 2),
		version: 1,
		title: 'Paste photos straight into the chat',
		body: '- ✨ Copy a screenshot or an image and paste it directly into the message box — on the web and on Android. It lands as an attachment you can review before sending, with a caption if you want one, exactly like photos picked from your gallery.'
	},
	{
		id: 'cordn-news-2026-10-01-nostr-embeds',
		createdAt: Date.UTC(2026, 9, 1),
		version: 1,
		title: 'Notes from the wider Nostr world, right inside the chat',
		body: '- ✨ Pasting a nevent, naddr, or note link (with or without the nostr: prefix) now renders the note as an inline card in the chat — author, time, and content, loaded straight from the relays. A ⋯ menu on each card copies the entity or opens it in nostr.at, njump.me, or Jumble, and if an event can’t be found you still get a link out to it.\n- ✨ Markdown tables now render in messages, embedded notes, and news cards — pipe rows with a --- separator line, including column alignment.\n- 🔄 Very long messages and embedded notes clamp behind a “Show more” button to keep the timeline compact; you can turn that off in Settings → Chat behavior.\n- 🔄 Prefer links to stay links? Turn note embeds off in Settings → Chat behavior — pasted references stay plain text and nothing is fetched from relays, and a new “Open in app” entry in the ⋯ menu hands the note to an installed Nostr app on your device.'
	},
	{
		id: 'cordn-news-2026-10-01-reaction-timeline',
		createdAt: Date.UTC(2026, 9, 1),
		version: 1,
		title: 'Reactions in plain sight, attachments without the wait',
		body: '- ✨ Reactions no longer hide on old messages: every reaction now appears in the chat at the moment it happened — “Alice, Bob +3 reacted 👍” — and a tap on See jumps straight to the message it was about. Prefer a messages-only timeline? Turn it off in Settings → Chat behavior.\n- ✨ You can take a reaction back: tap your own reaction chip — or your emoji in the reaction picker — to remove it — and if that was a slip, one more tap puts it right back. Reactions you send now stand out on the chip, so the tap target is clear.\n- 🐛 Photos and files show up in the message box the instant you pick them: preparing them privately (stripping metadata, converting HEIC photos) now runs in the background behind a small spinner on the attachment, instead of delaying its appearance — most noticeable on phones. Send unlocks as soon as the attachment is ready, since what goes out is exactly the prepared file.\n- 🔄 Profile pictures anchor to the newest message of a group again — the recent move to the top of the group left the latest messages without an identity anchor beside them.\n- 🔄 The unread-mentions “@” counter moved out of the message box: it now floats beside the scroll-to-bottom button at the bottom-right of the chat, keeping the composer compact.'
	},
	{
		id: 'cordn-news-2026-10-01-md-convergence',
		createdAt: Date.UTC(2026, 9, 1),
		version: 1,
		title: 'Linked devices heal their own splits',
		body: "- 🐛 A group could fall permanently out of sync on one of your linked devices after a bad connection — new messages stopped decrypting there and never recovered on their own. Cordn now keeps retrying what failed to sync until it succeeds, and a run of messages that won't decrypt triggers an immediate re-sync instead of waiting.\n- 🐛 When two of your linked devices changed a group at the same moment — both inviting someone, say — the group could split into two histories that never rejoined, leaving the group's messages unreadable on one side forever. Your devices now work out which change the group actually followed, rejoin it automatically, and leave a note in the group's sync issues saying what happened. Messages sent during the split on the abandoned side remain unreadable — that loss is baked into the encryption — but it's now a narrow window instead of a permanent fork, and it's visible instead of silent.\n- 🐛 The automatic repair that runs when two of your own devices send at the same time no longer makes things worse: it used to sometimes commit its fix while the device was out of sync — one of the causes of those splits — and now waits until the device is fully caught up.\n- 🔄 A single message that can never be decrypted (sealed under state the group has left behind) no longer stalls its chat forever: once Cordn verifies it is fully caught up, it skips past that message, marks it in the group's sync issues, and later messages flow again."
	},
	{
		id: 'cordn-news-2026-10-01-coordinator-health',
		createdAt: Date.UTC(2026, 9, 1),
		version: 1,
		title: 'False “coordinator unreachable” alarms are gone',
		body: "- 🐛 The “Coordinator unreachable (recent failure; retrying soon)” warning no longer appears while your coordinator is actually up. It was armed by anything that went wrong on a request — even a server error or a signer hiccup that never touched the coordinator — and then paused reads for a minute anyway. Only real connection failures count now, so when you see the warning, it is true.\n- 🐛 Coming back to the app no longer greets you with an unreachable coordinator your own device invented: connection failures while Cordn is sitting in a background tab or a sleeping phone — throttled timers, a radio that went quiet — are no longer counted against the coordinator, the same rule the reconnect logic already follows.\n- 🔄 A single slow request no longer tears down the connection to its coordinator, taking your live group updates down with it. The connection is rebuilt only when it is actually stuck — repeated timeouts in a row — so one hiccup no longer restarts every stream you have open.\n- 🐛 The one-minute pause that follows a real connection failure can no longer stretch far past its minute when your device's clock drifts and corrects itself."
	},
	{
		id: 'cordn-news-2026-09-29-pinned-chats',
		createdAt: Date.UTC(2026, 8, 29),
		version: 1,
		title: 'Pinned chats, drag-and-drop, and a steadier app',
		body: "- ✨ Pin the groups you care about to the top of your chat list: press and hold a chat on your phone (or open its “⋮” menu) to pin or unpin it. Pinned chats keep their place above everything else — your pins are personal and stay on your device.\n- ✨ On the web, drop files straight onto the chat window and they wait in the message box for review — send when you're ready.\n- 🔄 Zooming into shared images on your phone finally feels right: pinch to zoom, drag to pan, and double-tap to jump between 1× and zoomed — and the image can no longer be dragged out of sight. On desktop, the mouse wheel now zooms toward the pointer.\n- 🔄 Group cards and notifications now say what actually arrived — “📷 Photo”, “📎 file.pdf”, “🎤 Voice message”, or who just joined the group — instead of falling back to the group description or “Group chat”.\n- 🐛 Busy groups no longer flood your notifications: a burst of new messages shows as a single notification per group — the newest message with a “+N more” hint — instead of one alert per message.\n- 🐛 Replying to a message while sending a photo with a caption no longer drops the reply: the photo goes out as a proper reply.\n- 🐛 On Android, downloading an image or file now saves it through the system save dialog, instead of popping up the share sheet.\n- 🐛 The bottom bar no longer vanishes: opening some groups' info pages could crash the interface until the app was restarted, caused by a duplicated internal record on the device. The record now heals itself the first time the page opens.\n- 🐛 The supporter zap counter on the news page now counts zaps sent to both of the project's addresses — it undercounted since the second one went live.\n- 🐛 On Android, notifications are tidier: reading a group clears its notification right away, and leftovers no longer linger for chats you've already read.\n- 🐛 A message you sent no longer marks its own group unread when the coordinator confirms it (the check mark) — the badge now counts only what others sent.\n- 🐛 Sender avatars no longer flash or re-fade when you open a group, a message arrives, or you scroll through history — already-loaded pictures paint instantly, and each avatar now sits at the top of its message group next to the name instead of hopping between messages."
	},
	{
		id: 'cordn-news-2026-09-28-stranded-publish-heal',
		createdAt: Date.UTC(2026, 8, 28),
		version: 1,
		title: 'Linked devices keep up after a bad connection',
		body: "- 🐛 A change made right as the connection dropped — a rename, an invite — could silently never reach your other devices until you touched that group again. Cordn now remembers what it still owes the fleet and pushes it on the next app open, so linked devices keep up on their own.\n- 🔄 Catching up a behind device is faster: each group's history recovery and message fetch now run side by side, and more groups reconcile at once — so one slow coordinator no longer stalls the groups waiting behind it."
	},
	{
		id: 'cordn-news-2026-09-28-coordinator-relays',
		createdAt: Date.UTC(2026, 8, 28),
		version: 1,
		title: 'Self-hosted coordinators work everywhere',
		body: "- 🐛 Groups synced to a linked device through multi-device now arrive knowing their coordinator's relays, so a group served by a self-hosted coordinator is reachable immediately — previously it silently fell back to the public default relays and never connected.\n- 🔄 Coordinators without saved relays are no longer pinned to the public default relays: Cordn now discovers where they listen from the coordinator's own published relay list, with the defaults kept only as a last resort.\n- 🔄 Discovered relays are remembered after first contact, so later sessions connect directly without repeating the lookup, and a coordinator's page gains a “Refetch relays” action for the rare case a coordinator moves.\n- 🔄 Coordinator cards and share links tell the truth about relays: unsaved shows an “auto-discovered” badge instead of listing relays the app may not actually use, and links only embed relays that were explicitly saved."
	},
	{
		id: 'cordn-news-2026-09-28-send-keeps-up',
		createdAt: Date.UTC(2026, 8, 28),
		version: 1,
		title: 'Sending keeps up when a coordinator is down',
		body: '- 🐛 Messages to chats on healthy coordinators send and confirm instantly again — with one coordinator offline, every message used to sit on a clock for up to 20 seconds at a time before clearing, even though it had already arrived.\n- 🐛 Sending over a flaky connection can no longer leave a message stuck on the clock or send it twice: a message that made it through is recognized as delivered the moment it arrives, and every retry counts as the same message.\n- 🔄 On Android, notifications from your other chats arrive on time even while a coordinator is offline — notification checks no longer queue up behind the unreachable server’s timeouts.\n- 🐛 On Android, background notifications no longer stop after the app is opened fresh from closed.'
	},
	{
		id: 'cordn-news-2026-09-27-nip44-false-alarms',
		createdAt: Date.UTC(2026, 8, 27),
		version: 1,
		title: 'Signer NIP-44 false alarms are gone',
		body: "- 🐛 Coordinators no longer wrongly report “your signer does not support NIP-44 v2” in the notifications drawer while it actually does. That message appeared when a browser-extension signer hadn't finished loading as Cordn started — and then stuck for the whole session. Cordn now waits for the signer to be available before judging its capabilities, and picks them up by itself as soon as the extension appears.\n- 🐛 The “signer doesn't support NIP-44 v2” banner no longer flashes while your extension is still loading — it only appears once the signer is actually present and truly lacks NIP-44 v2.\n- 🔄 While your signer is still waking up, the notifications drawer stays quiet (the chat area keeps its small waiting hint) instead of listing one error per coordinator."
	},
	{
		id: 'cordn-news-2026-09-25-open-at-unread',
		createdAt: Date.UTC(2026, 8, 25),
		version: 1,
		title: 'Chats open where the new messages are',
		body: "- ✨ Chats open at the first unread message with a “New messages” marker above it, so you pick up exactly where you left off — and the back button carries a small dot while something new is waiting in another chat.\n- 🐛 A chat can no longer get stuck opening at an old unread spot after you have read it: what the unread badge shows and where a chat opens now always agree.\n- 🐛 Tapping a reply now scrolls to the original message instead of leaving you near the bottom of the chat.\n- 🔄 Long chats scroll steadily: the view no longer jumps around while messages settle on screen.\n- 🔄 Group cards and notifications show names instead of nostr codes, and a group's info page names its coordinator instead of showing a raw key.\n- 🔄 The reaction emoji picker wraps into a neat grid that scrolls vertically, with the custom-emoji option always visible at the bottom instead of hiding behind a sideways scroll.\n- 🔄 Pinch zoom is off in the web app (matching the native app) so it stops getting in the way of chat gestures."
	},
	{
		id: 'cordn-news-2026-09-22-ostrich-theme',
		createdAt: Date.UTC(2026, 8, 22),
		version: 1,
		title: 'Ostrich: a purple theme with a bitcoin heart',
		body: "- ✨ New Ostrich theme in Settings → Appearance: deep nostr-purple surfaces, a vivid violet accent, and a bitcoin-orange focus ring for that ⚡ touch. Every color combination is checked to stay comfortably readable (WCAG AA) in both light and dark mode.\n- 🔄 Ostrich takes Dracula's seat in the lineup. If Dracula was your active theme you land on Classic — and if purple is your thing, Ostrich is one tap away. Any look you lost can be rebuilt in the theme editor: fork, tweak, export."
	},
	{
		id: 'cordn-news-2026-09-22-sturdier-sends',
		createdAt: Date.UTC(2026, 8, 22),
		version: 1,
		title: 'Sturdier offline sends, smoother long chats',
		body: "- 🐛 A queued message that can't be delivered at all (for example after you are removed from the group) no longer keeps trying in the background forever: it is marked failed and waits for you, and one tap retries it.\n- 🐛 A message whose send was cut off mid-way is now re-sent only after the app has confirmed it never arrived — a flaky connection can no longer deliver the same message twice.\n- 🐛 The notifications dialog now always names the right coordinator when one fails a check: the error details used to stay stale after a retry.\n- 🔄 Importing a theme with an invalid color value is now caught right away, instead of the color being quietly dropped and falling back to a default.\n- 🔄 Long chats do less work with every update: sending, reacting, and scrolling stay smooth even in conversations with thousands of messages, and other groups syncing in the background no longer slow down the chat you are looking at."
	},
	{
		id: 'cordn-news-2026-09-21-signer-capability',
		createdAt: Date.UTC(2026, 8, 21),
		version: 1,
		title: "When your signer can't do something, Cordn now says so",
		body: "- 🐛 Linking a device while signed in with a signer that doesn't support NIP-44 v2 (some browser-extension signers) no longer pretends to succeed: it used to finish with “0 groups seeded”, a healthy-looking sync, and no error anywhere — now it's refused up front with a message naming the signer.\n- 🐛 Joining a group and handling invitations no longer hang for twenty seconds and then blame the network when the signer is the actual limit: actions your signer can't support fail immediately and say why, instead of a fake timeout.\n- ✨ A small banner now appears when the active signer lacks NIP-44 v2, explaining that messaging keeps working while joining groups, invitations, and device sync need a signer that supports it.\n- 🔄 The multi-device page reports its true state: “Sync active” only shows once a sync has actually happened, a linked device that hasn't synced yet says so, and a manual re-sync explains exactly what went wrong — the signer, the relays, or an unreadable tip — instead of one generic message."
	},
	{
		id: 'cordn-news-2026-09-21-offline-outbox',
		createdAt: Date.UTC(2026, 8, 21),
		version: 1,
		title: 'Write now, send later — messages survive being offline',
		body: "- ✨ Text messages you send while offline no longer fail: they wait in the chat with a small clock icon and send on their own as soon as the connection returns — even if you closed the app or reloaded the page in between.\n- 🐛 A send interrupted by a dropped connection or a closed app can no longer be lost or delivered twice: Cordn remembers exactly what was on its way and finishes the job once when you're back.\n- 🔄 Slow or flaky networks now get patient automatic retries instead of instant errors; if a message truly can't be delivered (for example the group is gone), it's marked failed and one tap retries it. Photos and voice notes still ask for a connection to upload."
	},
	{
		id: 'cordn-news-2026-09-21-heic-metadata',
		createdAt: Date.UTC(2026, 8, 21),
		version: 1,
		title: 'HEIC photos send properly — and photos leave their metadata behind',
		body: "- 🐛 Photos taken on phones set to save HEIC (for example Samsung's “extended color” mode) no longer arrive as empty images: they are converted to a widely viewable JPEG before being sent, so everyone in the chat sees them.\n- ✨ Photos no longer carry their metadata out of your phone: capture location, device model, and timestamps are stripped before sending on every device — the picture is just pixels. What you see in the composer preview is exactly what gets sent.\n- 🔄 A photo that arrived before this fix and can't be displayed now appears as a downloadable file instead of a silent blank, so it can still be saved and opened."
	},
	{
		id: 'cordn-news-2026-09-21-enter-key',
		createdAt: Date.UTC(2026, 8, 21),
		version: 1,
		title: 'An Enter key that fits your device',
		body: "- ✨ On phones, the return key now starts a new line instead of sending — writing a message with several lines no longer sends it halfway through. On devices with a keyboard, Enter keeps sending and Shift+Enter starts a new line, exactly as before.\n- ✨ Prefer it the other way around? The new Settings → Chat behavior page lets you choose: keep the automatic behavior, make Enter always send, or make Enter always start a new line (then send with Ctrl+Enter — ⌘ on Mac — or the send button).\n- 🐛 Typing in Japanese, Chinese, or Korean no longer risks sending your message early: pressing Enter to confirm a conversion in your keyboard's IME is no longer treated as send."
	},
	{
		id: 'cordn-news-2026-09-20-instant-sends',
		createdAt: Date.UTC(2026, 8, 20),
		version: 9,
		title: 'Messages send instantly when you come back',
		body: '- 🐛 Coming back to Cordn after your phone slept or the app sat in the background: messages now send right away. Connections that died silently while you were away are checked and repaired the moment you return, instead of failing with “timed out” until you tried again.\n- 🐛 Switching between Wi-Fi and mobile data mid-session no longer leaves sends stuck or failing: dead connections are detected and rebuilt on their own within about half a minute, and a send that hits a bad moment retries itself instead of failing until you sent it again.\n- 🔄 Messages are confirmed as soon as the first delivery server accepts them — no more waiting for the slowest one — so sends stay consistently fast even when one server is struggling.\n- 🐛 On Android, the message details screen no longer hides behind the status bar or notch, and the message input keeps a comfortable gap above the navigation bar on phones with the three-button bar — group info and message pages also scroll fully clear of it now.\n- 🐛 On Android, swiping from the edge of the screen to go back no longer briefly turns on the microphone — which used to pause your music — and holding the mic button to record stays reliable while you naturally move your finger.\n- 🐛 System messages like “Alice added Bob to the group” no longer break apart when names are long or the screen is small: names sit on a single truncated line, properly aligned with the surrounding text, and the date separators between days now have subtle divider lines.\n- ✨ Coordinators now show their real names — from their Nostr profiles — everywhere, including the settings cards, instead of a generic “Coordinator abcd1234”.\n- ✨ You can share a coordinator: a Share action on the coordinator card and its detail page gives you a QR code or link that pre-fills the add form on another device.\n- 🔄 The relays each coordinator uses are now shown honestly: pages and links always reflect the relays the app actually connects through, and where built-in defaults apply they are labeled and listed instead of hidden.\n- 🐛 Opening the app from a message notification now shows the new messages right away from local storage, instead of briefly acting like it was downloading them again.\n- 🐛 Message notifications no longer pop up while you’re using the app — they now only appear while Cordn is in the background, and opening the app clears them all, including leftovers from groups you’ve left or removed.\n- ✨ Tapping an emoji reaction now shows it under the message right away instead of after a wait, just like sending a message — and if the send fails, the reaction quietly disappears and the error is shown.\n- ✨ Messages now understand basic Markdown: **bold**, *italic*, `code`, lists, quotes and code blocks render right in the chat, and links and @mentions keep working inside them. Plain messages look exactly the same as before.'
	},
	{
		id: 'cordn-news-2026-09-17-notifications-storm',
		createdAt: Date.UTC(2026, 8, 17),
		version: 1,
		title: 'Calm, reliable notifications',
		body: '- 🐛 Loading your invitations and join requests no longer gets stuck in a rapid retry loop — a rare timing bug made the app quietly fire several freshly-signed coordinator requests per second while the notifications list never finished loading. Beyond keeping your notifications from appearing, it drained battery and data until the app was restarted.\n- 🔄 Invitations and join requests now load on a steady five-minute schedule, and each coordinator is checked independently — one coordinator having trouble can no longer disturb the others, and any error names exactly which coordinator failed.\n- 🔄 Coordinator health changes no longer trigger redundant background refetches on coordinator pages and key-package lists, so those screens are steadier and quieter.'
	},
	{
		id: 'cordn-news-2026-09-16-appearance-themes',
		createdAt: Date.UTC(2026, 8, 16),
		version: 1,
		title: 'Make Cordn yours: themes',
		body: '- ✨ New Appearance page in Settings with eight built-in themes — Soft (the new default for new users), Classic, Matrix, Cypherpunk, Navy, Warm Paper, Catppuccin, and Dracula. Everyone who already used Cordn keeps their familiar look.\n- ✨ Customize any theme: fork it, tweak every color and the corner radius, and watch the whole app preview your changes live while you edit.\n- ✨ Not sure where to start? Hit "Roll" to generate a random theme — every roll is checked to stay readable (WCAG AA) automatically, so keep rolling until one feels right.\n- ✨ Themes can be edited as JSON too: copy the object, tweak it in your own editor or with the help of an AI agent, paste it back, and apply it live. Export and import round-trips the same file, so you can share themes between devices.\n- 🔄 The in-progress draft now survives navigating away and back — leave Settings mid-edit, look around, come back, and continue where you left off.\n- 🔄 Cordn now uses your device\'s system font, which makes it feel more native, load faster, and work offline.'
	},
	{
		id: 'cordn-news-2026-09-11-foreground-reliability',
		createdAt: Date.UTC(2026, 8, 11),
		version: 1,
		title: 'No more stalls when you come back',
		body: '- 🐛 Coming back to Cordn after it sat in the background no longer leaves you stuck waiting on a healthy coordinator — sending a message, invitations, and key packages now go through fresh connections right away, where the app previously could hang on stale ones until you restarted it.\n- 🔄 Connections are only rebuilt when something actually went wrong while you were away (a real suspension, or a connection that stopped responding) instead of on every return, so ordinary tab switches no longer cause reconnect churn.\n- 🔄 Every coordinator call now has a firm time limit: anything that would hang fails fast and its connection is replaced cleanly, instead of leaving a spinner forever.\n- 🐛 A laptop sleep that keeps the tab “open” is detected too — returning from it rebuilds your chat connections and pulls in anything you missed.\n- 🔄 Recovery waits for your signer (like Amber) to wake up before reconnecting, avoiding a burst of failed calls right after you return.\n- 🐛 Deleting a group that was not connected at that moment no longer disturbs the connections of your other chats.'
	},
	{
		id: 'cordn-news-2026-08-18-batch-invites',
		createdAt: Date.UTC(2026, 7, 18),
		version: 2,
		title: 'Faster invites, tidier key packages',
		body: '- ✨ Creating a group with several members is now much faster: everyone is added in a single batch instead of one member at a time, so a large group no longer waits on a separate invite round for each person.\n- 🔄 Members who can\'t be invited (for example, no key package published on the coordinator) are still reported one by one, and everyone else joins in the same batch.\n- 🐛 The key packages settings no longer show a package as published after the coordinator has already let it go (for example, once it was used for an invitation), and removing such a package now always works instead of failing because the coordinator can no longer find it.\n- 🔄 "Clean up consumed" now also clears used packages whose publish markers went stale, so the list stops collecting zombies.'
	},
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
	},
	{
		id: 'cordn-news-2026-09-07-backup-export',
		createdAt: Date.UTC(2026, 8, 7),
		version: 1,
		title: 'Backups no longer crash on Android',
		body: '- 🐛 On Android, exporting a backup with your message history no longer crashes the app the moment the save dialog opens. The August fix stopped the crash for smaller backups, but larger ones still took the app down — any size now saves cleanly to the spot you pick.'
	},
	{
		id: 'cordn-news-2026-09-09-coordinator-independence',
		createdAt: Date.UTC(2026, 8, 9),
		version: 1,
		title: 'Chats keep working when a coordinator is down',
		body: '- 🐛 A coordinator that goes offline no longer disturbs anything else: chats on healthy coordinators, the key-package directory, invitations, and join requests all keep loading, and lists no longer briefly empty or flicker while an unreachable coordinator is being retried.\n- 🔄 An unreachable coordinator is now retried gently, with growing pauses, instead of being hammered continuously — and it is picked back up the moment it responds again. Any error message now names which coordinator is having trouble instead of a bare “Request timed out”.\n- 🐛 Messages keep arriving while the Cordn window sits unfocused or in the background — previously it could quietly stop receiving new messages until you focused it or refreshed the page.\n- 🐛 A chat that quietly went silent no longer needs a page refresh: sending a message in it pulls in anything missed, and silent connections are detected and rebuilt on their own.\n- 🔄 When a chat connection does drop, it is rebuilt right away with a fresh identity — a reconnect can no longer leave a group quietly missing messages until you interact with it again.'
	},
	{
		id: 'cordn-news-2026-09-09-nav-bar',
		createdAt: Date.UTC(2026, 8, 9),
		version: 1,
		title: 'One navigation bar for every screen',
		body: "- ✨ The bottom bar — Chats, Notifications, Share, Settings — now appears on desktop too, so Settings is reachable there for the first time, and a “+” for new chats sits in the middle of the bar instead of a floating button.\n- ✨ Invitations and join requests now live in that bar as a Notifications tab with a red dot when something is waiting, instead of hiding behind a small icon in the sidebar.\n- 🔄 Unread signals on the bar are quiet red dots, matching the attention cues used across the app.\n- 🔄 Back arrows now go up one level — coordinators returns to Settings, not your chats — and desktop screens get a back arrow too instead of only the browser's.\n- 🐛 The Refresh button in the notifications dialog is no longer stuck on “Refreshing…”."
	},
	{
		id: 'cordn-news-2026-09-08-mark-all-read',
		createdAt: Date.UTC(2026, 8, 8),
		version: 3,
		title: 'Mark all read, and a friendlier mobile app',
		body: "- ✨ A “Mark all read” button now clears every chat's unread badges in one tap — it sits next to the chat search and on chat home, and only appears when something is actually unread.\n- 🔄 Coordinator names are consistent everywhere: cards, settings, and prompts all prefer your custom label, then the server-announced name, and background saves (like starting a chat from a profile) can no longer overwrite a name you set yourself.\n- ✨ The “Create group” button on a coordinator's page now pre-selects that coordinator in the new-group form.\n- ✨ On phones, a bottom bar — Chats, Share, Settings — and a floating “+” on chat home put the main actions one thumb-tap away.\n- ✨ Every screen now has a back arrow at the top left on mobile, so you can always find your way back to your chats.\n- 🔄 Chat home is calmer: the chats list lost its boxy frame and sits edge to edge, and quick actions shrank to a compact icon row in the sidebar.\n- 🔄 Group actions on mobile (info, invite, share) now open a bottom sheet sized for your thumb instead of a small dropdown.\n- 🔄 “Join group” is now “Open link”, and it also accepts bare profile identifiers (npub or nprofile) — paste one to open that profile.\n- 🔄 Message actions have a new home on desktop: a small toolbar floats beside the bubble on hover — never on top of it, and never cut off — and on narrow windows it folds into a single “…” that opens the full menu.\n- ✨ On touch screens, press and hold a message to react, reply, copy, pin, or edit it from a bottom sheet; the quick swipe-to-reply still works.\n- ✨ The emoji reaction picker is the same simple strip everywhere — the reaction button, the “…” menu, and the press-and-hold sheet."
	},
	{
		id: 'cordn-news-2026-09-10-send-faster',
		createdAt: Date.UTC(2026, 8, 10),
		version: 4,
		title: 'Snappier chats, quieter background',
		body: '- ✨ Messages send a beat faster in busy conversations: when a group is already receiving live updates in real time, the app no longer makes an extra network check before sending.\n- 🔄 Long chat histories load more smoothly — repeated crypto work that used to run per message now runs once per conversation update instead.\n- 🔄 Busy groups stay smooth while messages stream in: a conversation holding thousands of messages no longer stutters each time something arrives.\n- 🔄 Incoming messages trigger far less redundant copying and UI bookkeeping, and background coordinator status updates no longer stir the interface when nothing has actually changed.\n- 🐛 On Android, the update banner no longer hides behind the status bar and notch at the top of the screen — its Reload button stays in reach — and toasts now clear the gesture bar at the bottom.\n- 🐛 Inviting someone could fail with "key package not available" when linked devices ended up with different invite keys than the coordinator — devices now keep that key in sync automatically and repair past mismatches on their own, so invites work from any of your devices.'
	},
	{
		id: 'cordn-news-2026-10-14-long-chats',
		createdAt: Date.UTC(2026, 9, 14),
		version: 1,
		title: 'Long chats stay fast, search sees everything',
		body: "- ✨ Chats with thousands of messages no longer slow down the longer you use the app: history loads in small pages on demand, so switching between chats and scrolling back stays smooth no matter how far back the conversation goes.\n- ✨ Search now looks through a chat's entire history, not just what's on screen: older matches appear as they're found, and edited or deleted messages are handled correctly.\n- ✨ Unread and mention badges stay exact even with a big backlog — no more wrong counts when hundreds of messages piled up while you were away.\n- 🐛 A message that arrived while you were reading older history could stay invisible until the app was restarted.\n- 🔄 Opening a chat with unread messages lands on the first unread one even when the backlog goes back much further than what first loads.\n- 🔄 The app performs far fewer background checks and wake-ups, which means less battery drain and fewer stutters during long sessions."
	},
	{
		id: 'cordn-news-2026-10-28-snappy-switching',
		createdAt: Date.UTC(2026, 9, 28),
		version: 1,
		title: 'Faster chat switching, steadier titles',
		body: '- ✨ Switching between chats — and typing right after — is dramatically faster: each group\u2019s members and status are figured out once per change instead of being re-derived over and over while you browse.\n- ✨ The tab title no longer flickers between the unread count and the page name while messages arrive, and the unread badge now shows consistently on every screen.\n- 🔄 The app does far less busywork in the background: group updates are saved in batches, quiet chats are checked less often, and poll countdowns share one clock — less memory, battery use, and stutter during long sessions.\n- 🐛 Deleting a chat while a message was still being saved no longer risks leaving that send stuck forever.'
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
