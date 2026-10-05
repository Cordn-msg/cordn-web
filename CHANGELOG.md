# Changelog

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
