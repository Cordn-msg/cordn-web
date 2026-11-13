# Changelog

## 0.7.0 — 2026-11-13

### Features

- **chat:** import published NIP-51 emoji lists
- **chat:** keep unsendable packs last, discard a held message
- **chat:** emoji collection, pack compatibility probes, honest emoji sends
- **native:** drive Android Back from the app hierarchy, keyboard first
- **chat:** petname mark on 1:1 titles and clickable mentions
- **petnames:** edit-only form and a paw mark for local names
- **chat:** local petnames and named notification lines
- **chat:** show pending join requests as loading group cards and auto-accept their welcome
- **chat:** add floating day label while scrolling
- **onboarding:** guide first-time users from intro to first chat
- **notifications:** stack recent messages in a thread
- **notifications:** decrypt background message previews
- **chat:** draw emoji-only messages larger
- refine emoji rendering and pack discovery
- add custom emoji pickers and pack previews
- add NIP-30 custom emoji interop
- **chat:** omit own profile avatars from message rows
- **chat:** move message metadata inside the bubble
- **chat:** render NIP-34 pull request embeds
- **chat:** enrich NIP-84 highlight embeds

### Fixes

- **startup:** keep stale profile refreshes and configured relays honest
- **chat:** close the holes the emoji review found
- **native:** keep the query when Back goes up from a conversation child
- **ui:** keep a painted avatar visible when the shared cache evicts
- **native:** keep Back working while a collapsible is expanded
- **ui:** share avatar warmth across avatar components
- **deps:** upgrade Capacitor past the WebView proxy flaw
- **chat:** open group links from any client in-app
- **chat:** use absolute dates and bound day-label retries
- **chat:** keep petname labels scoped to their account
- **chat:** cache key packages with their coordinator
- **chat:** wait for a pending join without a busy poll
- **chat:** retain base epoch key for invite catch-up
- **chat:** stabilize floating day label scroll tracking
- **onboarding:** polish first-launch flow
- **migration:** ignore locally held key packages in the new-device probe
- **chat:** drop stale highlight event source beside article
- **notifications:** keep locked-screen taps and opt-out consistent
- **notifications:** show message text without sender labels
- **notifications:** keep chat image with stacked message lines
- **notifications:** preserve thread timestamps and drop stale previews
- **notifications:** render previews in hidden WebView
- **notifications:** honor preview opt-out on live path
- **notifications:** harden preview isolation and ordering
- **chat:** open legacy emoji-media rows with the current epoch key
- **chat:** avoid stale avatar reads and size underscore emoji
- **chat:** guard emoji pack requests against stale replies
- **chat:** cap long message bubbles at 90% of the message column
- **chat:** stop the open-group window read/write loop
- **chat:** hide duplicate highlight article source rows

### Performance

- **startup:** cache profiles across sessions, skip unopenable relays

### Docs

- **news:** announce Back hierarchy, published emoji packs and faster launches
- **news:** announce custom emoji collection and pack compatibility
- **news:** release note for links from other Cordn apps
- **news:** release note for the floating chat date
- **news:** announce pending join request cards
- **news:** announce the new onboarding flow
- **news:** announce custom emoji packs
- note the chat read trace flag for profiling
- **news:** one card for 2026-11-08 including the chat CPU fix
- document stacked ngit PR merge fallback
- **news:** announce in-bubble message metadata
- **news:** announce highlight sources and nostr pull request cards

### Refactor

- **chat:** name the article kind in highlight source filtering
- **chat:** drop unused dayLabel from chat messages
- **chat:** reuse the emoji-media tag constant
- **chat:** trim highlight and PR embed parsing to what renders

### Chore

- **chat:** chat read tracing and window memo reset

### Other

- **chat:** warm the group module to stop the timeout flake
- **chat:** bump emoji-only cap to 80px
- **chat:** cover emoji media resealing after an epoch change
- **chat:** drop tautological parser tests

## 0.6.1 — 2026-10-30

### Features

- add persistent multi-device activity log
- custom Blossom document hosts in multi-device advanced settings
- **chat:** per-attachment captions for staged media
- **chat:** render NIP-84 highlights in embedded nostr event cards

### Fixes

- adopt announced coordinator relays, never SDK fallback answers
- seed default coordinator without frozen relay snapshot
- preserve activity across overlapping config writes
- stop same-state multi-device republish storms
- stop multi-device settings page from freezing on mount
- close adoption, rotation-order, and batch-delete edge cases
- explicit rotation displaces the sticky last-resort identity
- retraction bookkeeping across observation races, rotations, and accounts
- harden coordinator purge retraction against auto-republish and crashes
- coordinator purge resurrecting under multi-device sync
- **chat:** keep the title writer alive on a corrupt group state
- **chat:** resolve dropped persist waiters when a group is deleted
- **chat:** make chatAttention the single page-title writer
- **chat:** revert the avatar pipeline to master
- **chat:** cap heartbeat catch-up backoff at 2min (flat window)
- **chat:** keep avatar warmth unbounded and drop forced decode work
- make the avatar warm cache a single honest LRU (evicted srcs go cold)
- serialize group deletes after coalesced persists (resurrect guard)
- **chat:** stop the list snapshot gate from freezing content-only updates
- **chat:** track measured row keys locally instead of the private itemSizeCache
- **chat:** hide reaction actions on messages that have no event yet
- **chat:** stop the bottom re-pin fight while reaction chips grow a row
- **chat:** anchor the avatar when a system row ends a message run
- **chat:** seed profile hints synchronously so remounted group cards don't blink
- **chat:** settle the anchor flight when its row cannot be restored
- **chat:** stop the resize correction from dragging the landed view into tall rows
- **chat:** render rows from a list snapshot swapped atomically with the virtualizer
- **chat:** settle scroll ownership on every flight exit
- **chat:** end a scroll flight's suppression when it completes
- **chat:** anchor the viewport when the window grows above it
- **chat:** stop the broken-media re-fetch blink loop
- **chat:** show reactions on poll messages in the rich view

### Performance

- **chat:** derive group state facts once per state, not once per read
- paint warm avatar remounts without re-preload or async pop
- cut idle background heat (persist coalescing, heartbeat backoff, decode memo, render churn)

### Docs

- announce multi-device reliability improvements
- **news:** announce faster chat switching and steadier titles
- **chat:** mark the post-delete resurrect edge as a known shortcut
- **news:** announce live reactions, nostr highlights and per-photo captions
- **news:** note the chat-list avatar blink fix in the quiet-fixes card
- **news:** announce the poll, media and notification fixes

### Refactor

- **chat:** drop the toChatMessage identity memo

### Other

- add tbone nip05
- **chat:** raise the presence flush hook budget for slow full-suite runs
- pin the check job to ubuntu-24.04

## 0.6.0 — 2026-10-15

### Features

- **chat:** render poll questions through the message-parts lane
- **news:** note the automatic reachability and the sharper callout
- **key-packages:** auto-publish last-resort on every coordinator
- **news:** announce long-chat performance work and prune shipped docs
- **chat:** always-deep message search over full history
- **chat:** windowed message histories in the reactive store
- **chat:** exact unread and mention counts from a durable message ledger
- **storage:** paginated history reads and putGroup write memo
- **news:** note the safer edits and landed mentions
- **chat:** make grouped reactions expandable with per-reaction jumps
- **news:** note the versatile search and quieter reactions
- **chat:** filter the share picker by group or person
- **chat:** search people and group titles from the chat sidebar and header
- **news:** note the notification reliability and UI fixes
- **chat:** remind non-exempted users to allow unrestricted background
- **news:** announce polls
- **chat:** add NIP-31 alt summaries and readable poll-vote content
- **chat:** group rich poll votes under their options
- **news:** say who ends up sending the duplicate
- **chat:** add NIP-88 polls with tap-to-vote and rich results
- **news:** note the editing honesty fixes
- **news:** announce share reachability and profile availability states
- **share:** add direct "Make me reachable" action to the share dialog
- **start-chat:** verify share reachability and clarify availability loading
- **news:** announce coordinator relay auto-refresh
- **coordinators:** auto-refresh coordinator relays on staleness and outage

### Fixes

- **chat:** stop the composer's transient auto-height from clamping the list scroll
- **chat:** stop the per-keystroke bottom-pin storm in the message list
- **key-packages:** honor the opt-out and scope the callout summary to its account
- **key-packages:** publish to coordinators added mid-session
- **chat:** land notification opens at the new messages
- **test:** make the appearance fresh-install boot order-independent
- **storage:** compare ledger reference senders case-insensitively
- **ui:** drop the profile-hint warm cache that blanked the app on boot
- **ui:** drop dead avatar srcs from the warm cache on error
- **chat:** ascending windowed loads and race-free window merges
- **chat:** queue edits as durable send intents
- **chat:** splice mentions at the query end instead of the caret
- **chat:** keep in-progress edits and mentions across composer remounts
- **chat:** keep the header search button icon-only
- **chat:** search from chat home and scope it inside groups
- **chat:** show only other people's reaction rows in the timeline
- **chat:** collapse same-user reaction marker rows
- **chat:** keep pinned groups on top in the share picker
- **chat:** keep lightbox toolbar clicks from closing the overlay
- **chat:** never leave the share picker in the back stack
- **chat:** re-pin the message list synchronously on container resize
- **native:** request the battery exemption once at launch
- **chat:** forgive empty option rows in the poll composer
- **chat:** hide edit action on poll rows
- **chat:** poll card contrast on own bubbles
- **chat:** attach poll vote mentions to the poll row
- **chat:** poll tallies dropped every vote on deadline polls
- **chat:** reflect pending edits in reply quotes
- **chat:** only offer edit on messages that are actually sent
- **chat:** make reply-quote taps jump from pending bubbles too
- **chat:** guard reply consumption and keep the armed reply per group
- **chat:** keep reply quotes visible and attached across send paths

### Performance

- **ui:** warm avatar caches so list remounts paint without fallback pop
- **chat:** drop per-batch permission calls and watch ensure ticks

### Docs

- **news:** announce the calm-while-typing chat fix
- **key-packages:** note the fleet-owned mint gate in the AGENTS invariant
- sync history docs with landed names, add window invariant to AGENTS
- mark long-history phases 1-2 landed, correct the search design
- **share:** align profileShareHint module header with its mapping role

### Refactor

- **chat:** drop dead void guards in the messages effect
- **chat:** drop leftover temp in the per-group reply restore
- **chat:** remove dead reply author-label plumbing

### Other

- **chat:** reuse the menu opener in the edit e2e
- **chat:** harden the edit e2e against stale menus and early settles
- **chat:** cover message editing across send states end to end
- **share:** lock per-coordinator reachability in the share dialog
- **coordinators:** e2e smoke for coordinator relay auto-refresh

## 0.5.5 — 2026-10-07

### Features

- **chat:** add GIF picker via gifs.nostr.build
- **news:** announce mention-caption and video-playback fixes
- **news:** announce the notification-tap first-unread fix
- **news:** announce the typing and scrolling smoothness fix
- **news:** announce Staircase as a cordn.net link handler
- add Staircase to cordn.net app links

### Fixes

- **chat:** ignore media elements in bubble swipe/long-press gestures
- **chat:** keep composer focus away from video controls on touch
- **chat:** format mention tokens in composer previews
- **chat:** serialize mentions in media and voice captions
- **native:** open notification-tap group at the first unread message
- close summary-cache invalidation gaps and dedupe the reference matcher

### Performance

- lazy cursor set in unrecoveredDropHorizon
- keep message history out of the $state deep proxy
- cache per-group chat summary on one pass per event
- debounce presence writes and cache per-message hot-path scans

## 0.5.4 — 2026-10-06

### Features

- **chat:** render cordn invite links as cards
- **news:** announce the profile start-chat fix

### Fixes

- **chat:** label the group delete action plainly "Delete group"
- **chat:** drop the generic filler line from unknown-group invite cards
- **chat:** render invite-card icons as emoji text with the Cordn logo fallback
- **chat:** invite card's Show link must not stretch the bubble
- **chat:** heal wedged held sends and let users discard stuck outbox bubbles
- **chat:** guard mention candidates against transient group-store gaps
- **chat:** mark only visible messages read when opening a group
- **chat:** keep playing media mounted across message-list rebuilds
- **news:** unstick a bullet glued to the previous line
- **chat:** restrict the fresh-group catch-up skip to creator-born groups
- **chat:** trim the start-conversation flow to the protocol minimum

### Docs

- **news:** publish the ui-ux-fixes highlights to the in-app feed

### Refactor

- **chat:** final review pass — a11y parity and dead narrowing

### Chore

- **debug:** add profile start-chat repro script

### Other

- **chat:** prove the fresh-group skip discriminator through real birth paths

## 0.5.3 — 2026-10-05

### Features

- **news:** announce the disappearing-messages fix release
- **chat:** recover messages dropped by the pre-fix pipeline

### Fixes

- **md:** final-pass consistency fixes from the pre-release review
- **md:** content addresses are computed locally, never taken from a host
- **md:** tip acceptance rules at the relay layer
- **md:** unopenable documents are resealed, never re-pinned (fork-MR scenario G)
- **md:** reset the publish backoff after a successful push
- **chat:** refuse a key package for another identity (fork-MR scenario K)
- **md:** publish retry ladder, tip re-read before push, no meta hint ping-pong
- **chat:** retain former-epoch payload keys (report-05 disappearing messages)
- **chat:** settle lost own-commits and stage one commit at a time
- **chat:** stale-epoch discipline and the parked-cursor floor
- **chat:** repair ratchet divergence only on our own leaf's collision
- **chat:** gate behind groups and roll back definitively rejected commits
- **chat:** keep ingestion alive when a StoreWelcome fails
- **chat:** make own-commit adoption durable and IDB writes clone-clean

### Refactor

- **chat:** own-commit op machine and named sibling rule
- **storage:** drop unused putKeyPackage API

### Other

- **chat:** cover the sibling-commit detector end to end
- **chat:** cover the persistence boundary in the browser lane
- **chat:** reproduce own-commit adoption and IDB persistence bugs
- add drtodd pubkey

## 0.5.2 — 2026-10-05

### Features

- **chat:** recover messages dropped by the pre-fix pipeline

### Fixes

- **md:** final-pass consistency fixes from the pre-release review
- **md:** content addresses are computed locally, never taken from a host
- **md:** tip acceptance rules at the relay layer
- **md:** unopenable documents are resealed, never re-pinned (fork-MR scenario G)
- **md:** reset the publish backoff after a successful push
- **chat:** refuse a key package for another identity (fork-MR scenario K)
- **md:** publish retry ladder, tip re-read before push, no meta hint ping-pong
- **chat:** retain former-epoch payload keys (report-05 disappearing messages)
- **chat:** settle lost own-commits and stage one commit at a time
- **chat:** stale-epoch discipline and the parked-cursor floor
- **chat:** repair ratchet divergence only on our own leaf's collision
- **chat:** gate behind groups and roll back definitively rejected commits
- **chat:** keep ingestion alive when a StoreWelcome fails
- **chat:** make own-commit adoption durable and IDB writes clone-clean

### Refactor

- **chat:** own-commit op machine and named sibling rule
- **storage:** drop unused putKeyPackage API

### Other

- **chat:** cover the sibling-commit detector end to end
- **chat:** cover the persistence boundary in the browser lane
- **chat:** reproduce own-commit adoption and IDB persistence bugs
- add drtodd pubkey

## 0.5.2 — 2026-10-02

### Features

- **chat:** open-in-app handoff and an embeds on/off setting
- **markdown:** GFM-style pipe tables in the custom parser
- **chat:** embed pasted nostr events inline with long-content clamping
- **chat:** remove your own reactions; visibly mark them as yours
- **chat:** add setting to toggle reaction timeline rows
- **chat:** render reactions as marker rows in the message timeline
- **chat:** paste images into the composer on web and android
- **news:** linked devices heal their own splits
- **md:** fork evidence, descent check, commit-point rank (spec §8/§10)

### Fixes

- **chat:** remove phantom spacing between embed card sections
- **chat:** kill phantom line-box gap in embed header
- **chat:** embed header stacks meta under the author; media fills phone bubbles
- **chat:** adaptive fixes for embeds and inline media on narrow screens
- **chat:** embed meta contrast, article titles, three external viewers
- **chat:** readable embed author names + inline avatar
- **chat:** embed card polish — skeleton width, author contrast, ⋯ menu
- **chat:** stop rendering the runTail comment as message text
- **chat:** anchor run avatars to the newest message again
- **chat:** suppress reaction rows directly under their target
- **chat:** move unread-mention jump button beside scroll-to-bottom
- **chat:** stage attachments instantly with visible processing state
- **coordinator:** stop marking healthy coordinators unreachable
- **md:** fork-epoch keying + the chain-jump adoption gate
- **md:** arm failed-pull retries for the soonest due gid
- **md:** converge reliably — fetch liveness, fork tie-break, repair discipline, bounded hold

### Docs

- **news:** split nostr embeds and markdown tables into their own release card
- **news:** note removed reactions are one tap to restore
- **news:** announce reaction timeline, instant attachments, mention button move
- **news:** publish coordinator-health release card

### Refactor

- **settings:** dedupe persisted chat-behavior bools
- **chat:** fold review findings from the final pass
- **chat:** drop unused systemCommitter on reaction rows

### Chore

- **coordinator:** align teardown-policy comments with behavior
- ignore .pi (pi agent local config)

## 0.5.1 — 2026-09-29

### Features

- **chat:** drag and drop files into the chat composer
- **chat:** pin groups to the top of the list
- **coordinators:** persist resolved relays after first discovery + refetch action
- resolve profile names in group card previews and notifications
- render coordinator label on group info page
- unread marker + virtualizer-proof open-at-unread landing
- ui ux wins for 0.5.x patch

### Fixes

- **chat:** stop avatar re-renders on group open and new messages
- **chat:** own messages never count as unread
- **chat:** clear a group's notifications when it is read
- **native:** don't notify for messages the live path already handled
- **donations:** count zaps to both project pubkeys
- **chat:** real previews for media and system messages on cards
- **chat:** keep the reply when sending media with a caption
- **chat:** one sync issue per cursor — info page render crash
- **native:** save downloads via the Save-as picker instead of the share sheet
- **chat:** collapse notifications to one per group per pass
- **chat:** working pinch-zoom, pan and double-tap in the media lightbox
- **multi-device:** scheduleOwedPublish must read a fresh config
- **multi-device:** durable owed-push record heals stranded publishes (spec §10.5)
- feeditems
- **coordinators:** resolve relay-less coordinators via discovery instead of defaulting to contextvm relays
- **multi-device:** adopt coordinator relay hints from group documents (spec §4.1/§9)
- close seedBackground account-switch race; simplify dispatch pass
- **outbox:** decouple lane scheduling so a dead coordinator never delays other groups' sends
- decouple coordinators so one outage can't stall the others
- keep drawer and capability banner quiet while the signer wakes up
- stop false NIP-44 unsupported reports for late-injected signers
- open-at-first-unread actually lands on the first unread
- keep the bottom-pin glued to the bottom while rows settle
- read marks cover stored messages above the ingest counter
- assign scroll anchor via instance local, not store member syntax
- smooth virtualized chat scrolling

### Performance

- **multi-device:** overlap chain walk with gap fetch, widen reconcile pool

### Docs

- **news:** pinned chats + notification/lightbox/save/render-fix release card
- **news:** catch-up speed bullet on the stranded-publish card
- **news:** stranded-publish heal release card
- **news:** coordinator relay-hints + discovery release card
- **news:** publish send-keeps-up release card
- **news:** publish nip44-false-alarms release card
- **news:** publish open-at-unread release card

### Refactor

- polish pass on ui ux patches

### Chore

- **native:** drop unused @capacitor/filesystem and @capacitor/share

### Other

- update laeserin pubkey
- add hanshan nip 05

## 0.5.0 — 2026-09-22

### Features

- **themes:** replace Dracula with the Ostrich nostr theme
- queue text sends in a durable offline outbox
- **chat:** device-aware Enter key behavior with chat-behavior setting
- **chat:** render markdown in messages
- **chat:** optimistic reaction sends
- **coordinators:** share action, nprofile URLs, truthful relay display
- **coordinators:** resolve coordinator names from kind-0 profiles
- **chat:** adopt SDK 0.14.0 public probe() and ordered resume recovery
- keep the in-progress theme draft across navigation
- random theme generator with Roll button in the editor
- switch to the system font stack, drop bundled Inter
- lock corner radius between light and dark variants
- add six built-in themes (Matrix, Cypherpunk, Navy, Warm Paper, Catppuccin, Dracula)
- appearance settings with themes

### Fixes

- **deps:** keep devalue override on the patched 5.x line
- **deps:** floor prod-shipped transitives for known vulnerabilities
- **notifications:** make per-coordinator poll failures reactive
- **outbox:** make failed entries terminal and require a successful confirm sweep
- poll signer NIP-44 capability before showing the banner
- surface missing NIP-44 v2 signer capability instead of silent failures
- **chat:** fall back to noble Ed25519 on WebViews without WebCrypto Ed25519
- eliminate pending/confirmed double-render jump on message confirm
- **media:** truthful mime labels, HEIC transcode, and EXIF strip for photos
- **native:** suppress worker notifications while the app is foregrounded
- **native:** drain sidecar only after groups hydrate
- **chat:** align system-message name chips and center wrapped lines
- **chat:** rebuild system messages on Marker with truncating name chips
- **chat:** clear the voice arm timer when it fires
- **chat:** hold-to-arm voice note so back swipes don't grab the mic
- **chat:** clear Android system bars on overlays and bottom controls
- **chat:** probe coordinator relay pools at attention events
- **chat:** untrack reactive queryFn reads to stop effect dep pollution
- **chat:** stop welcome_take RPC storm from observer resubscription churn
- chatGroupWatch suite crash from file-scope warm import
- CI redness — playwright browser install + flaky heavy-import test timeouts
- unreadable card/popover text in dark variants of new themes

### Performance

- cut per-change message view work and isolate cross-group rebuilds

### Docs

- **news:** publish sturdier-sends release card
- **news:** publish signer-capability release card
- **news:** publish HEIC photo fix and metadata-strip release card
- **news:** coordinator names, sharing, and truthful relay display
- **news:** add voice-note gesture fix to the Sep 20 release notes
- **news:** add Android layout fixes to the Sep 20 release notes
- **news:** publish Sep 20 release notes for the pool liveness fix
- **news:** publish Sep 17 release notes for the notifications fix
- news release for the appearance themes update

### Refactor

- **chat:** drop inert observer config and dedupe relay resolution

### Chore

- tighten theme import validation and drop dead classes
- **android:** pnpm android boots the emulator, installs and launches
- bump @contextvm/sdk to 0.13.17 (CEP-22 probe no longer signs throwaway events)
- align Textarea import with the repo's ui component convention

### Other

- deflake outbox queue tests under parallel suite load
- add ngmi name

## 0.4.0 — 2026-09-11

### Features

- Signal-style message action bar with long-press sheet on touch
- mobile thumb-zone navigation and calmer chat home
- mark-all-read, consistent coordinator labels, coordinator-seeded group creation

### Fixes

- keep healthy coordinator sockets across unfocused desktop hides
- bump @contextvm/sdk to 0.13.16 for the acknowledged-probe keepalive fix
- crossfade chat avatars over fallback color to stop remount flash
- make coordinator connections reliable across app suspension
- converge last-resort key package across devices and coordinators
- clear system bars for update banners and toasts
- fold the new-conversation FAB into the tab bar as a center action
- unified chat tab bar with notifications and hierarchical back
- isolate coordinator failures and restore live-stream resilience
- spread sidebar quick-action icons across the sidebar width
- **build:** regenerate lockfile with pnpm 10 and pin packageManager
- **build:** restore ts-mls patch dropped from workspace config
- **android:** stop backup export crash when the save picker opens
- reconnection handling

### Performance

- memoize message label formatting
- cut redundant work from the send and ingest paths

### Docs

- add invite key sync bullet to today's news release
- add status-bar bullet to today's news release
- add label-smoothness bullet to today's news release
- add news release for the performance pass

### Chore

- update toddstr nip-05
- add toddstr nip-05

## 0.3.0 — 2026-08-18

### Features

- **chat:** add multiple members in one MLS commit
- **chat:** pull-to-refresh on the chat list
- web storage disclaimer banner and consistency pass
- **onboarding:** calm logged-out home with one clear first step
- chat-wide UI/UX refresh, Android stability fixes, crash diagnostics
- voice notes with hold-to-record and inline playback
- native camera capture, Android back button, and chat media polish
- portable cordn1 group links and foreground notification cleanup
- add keyboard plugin and edge-to-edge support
- add skater and bitcoin_sikho to .well-known/nostr.json

### Fixes

- **chat:** stop showing and failing to remove zombie key packages
- **chat:** harden peer-data parsing and skip redundant unread rescans
- **chat:** steadier reconnection lifecycle and calmer coordinator handling
- **chat:** bound the coordinator connect wait
- **chat:** steady-state ticks must be silent and never block sends
- **chat:** make watch reconnection convergent and signer-gated
- **ui:** coordinator dot only on active sidebar row; hide scrollbar gutter in sidebar nav
- **multi-device:** prevent cursor advance on sealed decrypt failure

### Refactor

- pre-release dead-code sweep and consistency pass
- **profile:** dedupe metadata and relay-list loading through Svelte Query

### Other

- publish to Zapstore manually via zsp, drop the CI publish job

## 0.2.4 — 2026-07-24

### Fixes

- **android:** compute versionCode via ProcessBuilder (exec threw -> versionCode 1)

## 0.2.3 — 2026-07-24

### Fixes

- **ci:** force git unshallow so versionCode isn't 1 on tag builds

## 0.2.2 — 2026-07-24

### Fixes

- **ci:** use full checkout so gradle versionCode isn't 1 in shallow clone

## 0.2.1 — 2026-07-24

### Features

- **news:** add 0.2.1 release notes
- add NIP-05/shortname profile links and join-group onboarding
- **android:** enable app links verification for cordn.net deep links
- close native/web gaps, add migration banner, refresh landing
- announce native Android app and update Zapstore badge link

### Other

- wrap long lines for readability

## 0.2.0 — 2026-07-23

### Chore

- add MIT license, public README, and NIP-05 domain verification

## 0.2.0-next.8 — 2026-07-23

### Fixes

- **native:** suppress push notifications triggered by your own actions
- **chat:** recover silent delivery failures and stale stream identities

## 0.2.0-next.7 — 2026-07-23

### Features

- **auth:** add the Amber signer app as a first-class login tab
- **native:** share into a conversation and open cordn.net links in-app
- **chat:** support multiple media attachments in composer

### Fixes

- **native:** flush the background sidecar when messages arrive in the foreground

### Chore

- refresh app icon, splash, and PWA assets

## 0.2.0-next.6 — 2026-07-22

### Features

- **native:** deep-link a notification tap to its conversation

### Fixes

- **native:** stop re-prompting notification permission on every message
- **android:** disable full backup to protect chat history and keys
- **native:** stop Android 15+ from force-stopping the FGS on its dataSync cap

### Chore

- clear pre-existing lint violations
- **android:** trim dead config and shrink the release APK

### Other

- **android:** publish changelog + signing-cert fingerprint; gate on lint

## 0.2.0-next.5 — 2026-07-22

### Fixes

- **android:** keep JNA + signer plugin classes from R8 so background fetch works in release
- **chat:** make open-stream subscriptions resilient to backgrounding + silent close

## 0.2.0-next.4 — 2026-07-21

### Fixes

- **ci:** use JDK 21 — capacitor-android compiles to Java 21 bytecode

## 0.2.0-next.3 — 2026-07-21

### Fixes

- **ci:** tolerate whitespace in keystore base64 secret

## 0.2.0-next.2 — 2026-07-21

### Fixes

- **signer:** seed pubkey on rehydration to skip re-prompting Amber

### Chore

- **release:** add CI/CD, APK signing, R8 minify, background relay re-sync

## 0.2.0-next.1 — 2026-07-20

### Fixes

- **deps:** patch vulnerable deps and pin safe transitive versions

### Chore

- **android:** name APK outputs with semver to prevent overwrite

## 0.2.0-next.0 — 2026-07-20

_First tracked release; prior history is in git._
