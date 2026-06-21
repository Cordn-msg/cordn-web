# cordn-web

[`cordn-web`](package.json) is the web client for Cordn.

It is built with SvelteKit, Svelte 5, TypeScript, and Tailwind CSS, and currently includes:

- a landing page at [`/`](src/routes/+page.svelte)
- a browser chat UI at [`/chat`](src/routes/chat/+page.svelte)
- route-based group navigation under [`src/routes/chat/[id]`](src/routes/chat/[id])
- a profile page under [`src/routes/p/[identifier]/+page.svelte`](src/routes/p/[identifier]/+page.svelte) for hex pubkeys, `npub`, or `nprofile` identifiers

## Chat storage model

Chat persistence is split by durability and data shape:

- Chat groups and key packages are stored through [`getChatStorage()`](src/lib/storage/chatStorage.ts:530).
- The primary backend is IndexedDB via [`IndexedDbChatStorage`](src/lib/storage/chatStorage.ts:331).
- If IndexedDB is unavailable, the app falls back to in-memory storage via [`MemoryChatStorage`](src/lib/storage/chatStorage.ts:195).

The canonical persisted chat payload includes:

- group metadata and cursors
- MLS group state as bytes in [`stateBytes`](src/lib/storage/chatStorage.ts:27)
- decrypted message history in [`messages`](src/lib/storage/chatStorage.ts:28)
- sync issues in [`syncIssues`](src/lib/storage/chatStorage.ts:29)
- key package material as bytes in [`keyPackageBytes`](src/lib/storage/chatStorage.ts:38) and [`privateKeyPackageBytes`](src/lib/storage/chatStorage.ts:39)

The browser services in [`chatGroups.svelte.ts`](src/lib/services/chatGroups.svelte.ts:1) and [`chatKeyPackages.svelte.ts`](src/lib/services/chatKeyPackages.svelte.ts:1) still expose the same app-facing APIs, but persistence routes through the storage layer instead of directly writing large JSON blobs to browser storage.

Writes are scoped to the changed group only: [`replaceGroup`](src/lib/services/chatGroups.svelte.ts:512) and `persistGroup` go through [`persistSingleGroup`](src/lib/services/chatGroups.svelte.ts:270), which persists one group on the shared chain instead of re-writing every group. [`IndexedDbChatStorage.putGroup`](src/lib/storage/chatStorage.ts:448) further skips messages already covered by the durable `fetchCursor` (the group record and its messages share one atomic transaction, so older cursors are already durable). Without this scoping, a single incoming message re-wrote every group × every stored message, making live delivery latency scale with the total group count. Bulk loads/migrations still use the batch [`persistGroups`](src/lib/services/chatGroups.svelte.ts:258) path.

## Catch-up filter (`sinceEpoch`)

When a new member joins a long-running group via [`acceptWelcomeToGroup`](src/lib/services/chatGroupLifecycle.svelte.ts:111), the MLS epoch at join time is captured from the [`ClientState.groupContext.epoch`](node_modules/ts-mls/dist/src/groupContext.d.ts:11) and stored as [`joinEpoch`](src/lib/services/chatGroups.svelte.ts:89) in [`StoredChatGroup`](src/lib/services/chatGroups.svelte.ts:75). This epoch is passed as [`since_epoch`](src/lib/contracts/index.ts:112) in all fetch/subscribe requests so the coordinator filters out messages from epochs before the member joined — messages that are undecryptable to the new member anyway.

- The [`toWatchableGroup`](src/lib/services/chatGroupWatch.svelte.ts:401) function converts `joinEpoch` (a `bigint`) to the wire-compatible `sinceEpoch` string when `joinEpoch > 0n`, and omits it for the group creator (`0n` = "give me everything").
- All fetch/subscribe paths pass `since_epoch`: [`fetchCoordinatorGroupBacklog`](src/lib/services/chatGroupWatch.svelte.ts:569), [`startWatchingCoordinatorGroups`](src/lib/services/chatGroupWatch.svelte.ts:614), and the per-group catch-up in [`catchUpGroupBeforeOutboundOperation`](src/lib/services/chatGroups.svelte.ts:397).
- Legacy groups without `joinEpoch` (from before this feature) default to `0n` via [`migrateStoredGroup`](src/lib/services/chatGroups.svelte.ts:114), which means no filtering — backward-compatible with coordinators that don't yet support `since_epoch`.

## Live group watching

Every watchable group is kept current by a single multiplexed subscription per coordinator, opened by [`startWatchingCoordinatorGroups`](src/lib/services/chatGroupWatch.svelte.ts:614). Several invariants prevent the duplicate fetches and orphaned subscriptions that would otherwise occur when a cold start races an account switch:

- **One authoritative starter.** [`startWatchingAllGroups`](src/lib/services/chatGroupWatch.svelte.ts:839) is the single entry point used by both the account-change handler and the steady-state chat-layout `$effect`. It is re-entrancy-safe via a singleton promise and computes a pure delta over the current watches (`getWatchableGroups({ includeCurrentWatches: false })`), so the two natural callers can never race to open duplicate backlog fetches or subscriptions.
- **Synchronous registration + intent-based teardown.** A new handle is recorded in `currentWatches` before any `await`, and its placeholder `abort`/`discard` record intent (`closing = true`) until the real `subscription.abort` is wired up. The post-resolve closing checks abort the subscription (or skip creating it) if it was torn down mid-start, and any stream/result error after `closing` is treated as expected teardown rather than a coordinator failure.
- **Bounded teardown.** [`closeWatch`](src/lib/services/chatGroupWatch.svelte.ts:164) is bounded by a timeout so an abort publish on an unhealthy socket can never hang teardown. Graceful teardowns still publish an abort for prompt server-side cleanup; the resume path uses local `discard` instead (see below).
- **Socket-safe recovery.** [`resumeChatGroupWatching`](src/lib/services/chatGroupWatch.svelte.ts:343) scopes a reconnect to the degraded coordinator instead of tearing down healthy subscriptions across all coordinators. Rather than aborting on the possibly-unhealthy old socket — relay publishes retry until ACKed, so that would hang indefinitely — a scoped resume locally discards that coordinator's watches ([`closeWatch`](src/lib/services/chatGroupWatch.svelte.ts:160) with `{ local: true }`) and rebuilds its client via [`replaceCoordinatorClient`](src/lib/services/chatRuntime.ts:237) so re-subscribe uses a fresh socket. An unscoped resume (view change / online) performs only a delta restart via [`startWatchingAllGroups`](src/lib/services/chatGroupWatch.svelte.ts:777): subscriptions that died while backgrounded unregister themselves on stream end, so only those groups are re-fetched and re-subscribed, while healthy (and stale-but-idle) subscriptions are left untouched (the SDK's dead-socket detection drives their scoped recovery). Account switches do not resume at all — they stop the previous account's watches and then call `startWatchingAllGroups`.
- **Silent fresh open.** The lifecycle listeners (`pageshow`/`focus`/`visibilitychange`) are gated on a `warmed` flag that is set only after the first watch startup settles (success or failure), so a fresh app open does not churn the watches the steady-state layout `$effect` is already starting (and does not flash the reconnect banner), while a failed initial start can still be retried by foreground. The `online` listener stays unconditional since it signals genuine connectivity recovery.
- **Delayed reconnect banner.** The "Updating chats…" banner is shown only after the rebuild exceeds a short threshold, so fast rebuilds no longer flash a useless banner, and never before the first watch startup.
- **No redundant per-send fetch.** Application messages (kind 9 / 7 / 1111 / 1010 / 5) never change the MLS epoch, so [`prepareGroupForApplicationMessage`](src/lib/services/chatGroups.svelte.ts:476) skips the pre-send catch-up for groups with an active subscription (checked via [`isGroupActivelyWatched`](src/lib/services/chatGroupWatchStatus.svelte.ts)) and only falls back to the full catch-up for groups that are not currently watched. Epoch-changing operations still always go through [`assertGroupCanPerformOutboundOperation`](src/lib/services/chatGroups.svelte.ts:445).

## Chat rendering performance

Long group histories are rendered with [`@tanstack/svelte-virtual`](package.json:65) in [`ChatMessageList.svelte`](src/lib/components/chat/ChatMessageList.svelte:55). The message list only mounts the visible message window plus overscan while preserving stable message ids for reply/reference navigation and unread-reference visibility checks.

When changing chat history rendering, keep [`scrollToMessage()`](src/lib/components/chat/ChatMessageList.svelte:75) and message [`data-message-id`](src/lib/components/chat/ChatMessageList.svelte:212) anchors working so references, mentions, and unread jumps can still navigate to off-screen messages through the virtualizer.

Per-message render work is reduced by caching parsed mention parts in [`chatMessageRenderCache.ts`](src/lib/components/chat/chatMessageRenderCache.ts:1), sharing custom reaction persistence across mounted rows, lazily mounting heavy menu/tooltip controls in [`ChatMessageItem.svelte`](src/lib/components/chat/ChatMessageItem.svelte:88), and throttling unread-reference visibility checks with `requestAnimationFrame` in [`ChatMessageList.svelte`](src/lib/components/chat/ChatMessageList.svelte:97).

## Notifications and unread visibility

- Chat routes keep browser-level unread visibility synchronized through [`syncChatAttention()`](src/lib/services/chatAttention.svelte.ts:73), which updates the document title with the unread message count while preserving the default favicon.
- Browser notifications for newly ingested inbound chat messages are dispatched by [`notifyForUnreadChatMessages()`](src/lib/services/chatAttention.svelte.ts:104), while suppressing alerts for the currently visible open group.
- The mobile sidebar toggle in [`ChatMobileSidebarButton.svelte`](src/lib/components/chat/ChatMobileSidebarButton.svelte) shows a small red dot when unread chat or welcome-notification attention is pending.

## Update detection

To prompt users to reload after a new deploy, the app compares a build-time version stamp against the deployed `static/version.json`:

- [`scripts/write-version.mjs`](scripts/write-version.mjs) writes [`static/version.json`](static/version.json) (`{ version, builtAt }`) from `git rev-parse --short HEAD` as a `prebuild` step before `pnpm build`. The file is gitignored because it is regenerated per build.
- [`vite.config.ts`](vite.config.ts) reads the same version and injects it into the bundle as `__APP_VERSION__` via Vite `define`, with a git-based fallback for `pnpm dev`. This guarantees the running bundle and the served marker share a source.
- [`src/lib/services/appUpdate.svelte.ts`](src/lib/services/appUpdate.svelte.ts) exposes the [`appUpdateStore`](src/lib/services/appUpdate.svelte.ts:32) and polls `/version.json` (cache-busted, `no-store`) on load and every 10 minutes, production only. A mismatch sets `appUpdateStore.available`. Detection is centralized here instead of duplicated per route.
- The sticky [`AppUpdateBanner.svelte`](src/lib/components/AppUpdateBanner.svelte), mounted once in [`src/routes/+layout.svelte`](src/routes/+layout.svelte), renders a reload prompt and starts/stops the watcher via `onMount`. Reload is always manual; dismissing remembers the skipped version in `sessionStorage` for the session.
- The service worker in [`src/service-worker.ts`](src/service-worker.ts) bypasses its cache for `/version.json` so polling never reads a stale marker.

## Identity and profile UX

- [`AccountLoginDialog.svelte`](src/lib/components/AccountLoginDialog.svelte) now supports revealing the private-key input with an eye toggle so users signing in with a raw key can verify and copy it for backup.
- The profile route at [`/p/[identifier]`](src/routes/p/[identifier]/+page.svelte) renders the extended [`ProfileCard`](src/lib/components/ProfileCard.svelte) view plus the locally stored groups shared with that profile.
- Shared-group discovery on the profile route is derived from local group membership via [`listChatGroups()`](src/lib/services/chatGroups.svelte.ts:243) and [`listChatGroupMembers()`](src/lib/services/chatGroups.svelte.ts:511), keeping the implementation local-first and avoiding redundant remote fetches.
- The profile route uses a stacked row layout and, when the viewed profile matches the active account, shows inline logout actions plus a simple metadata editor.
- Profile metadata publishing prefers the user's NIP-65 outboxes and falls back to `wss://relay.damus.io` and `wss://relay.primal.net` when mailbox data is unavailable.

## Development

- Install dependencies: `pnpm install`
- Start the dev server: `pnpm dev`
- Run checks: `pnpm check`
- Run linting: `pnpm lint`
- Run tests: `pnpm test`

## Build

- Production build: `pnpm build`
- Preview build: `pnpm preview`

## Related project

The protocol and server implementation lives in the nested [`cordn/`](cordn) workspace.
