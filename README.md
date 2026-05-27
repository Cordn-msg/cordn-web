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

## Chat rendering performance

Long group histories are rendered with [`@tanstack/svelte-virtual`](package.json:65) in [`ChatMessageList.svelte`](src/lib/components/chat/ChatMessageList.svelte:55). The message list only mounts the visible message window plus overscan while preserving stable message ids for reply/reference navigation and unread-reference visibility checks.

When changing chat history rendering, keep [`scrollToMessage()`](src/lib/components/chat/ChatMessageList.svelte:75) and message [`data-message-id`](src/lib/components/chat/ChatMessageList.svelte:212) anchors working so references, mentions, and unread jumps can still navigate to off-screen messages through the virtualizer.

Per-message render work is reduced by caching parsed mention parts in [`chatMessageRenderCache.ts`](src/lib/components/chat/chatMessageRenderCache.ts:1), sharing custom reaction persistence across mounted rows, lazily mounting heavy menu/tooltip controls in [`ChatMessageItem.svelte`](src/lib/components/chat/ChatMessageItem.svelte:88), and throttling unread-reference visibility checks with `requestAnimationFrame` in [`ChatMessageList.svelte`](src/lib/components/chat/ChatMessageList.svelte:97).

## Notifications and unread visibility

- Chat routes keep browser-level unread visibility synchronized through [`syncChatAttention()`](src/lib/services/chatAttention.svelte.ts:73), which updates the document title with the unread message count while preserving the default favicon.
- Browser notifications for newly ingested inbound chat messages are dispatched by [`notifyForUnreadChatMessages()`](src/lib/services/chatAttention.svelte.ts:104), while suppressing alerts for the currently visible open group.
- The mobile sidebar toggle in [`ChatMobileSidebarButton.svelte`](src/lib/components/chat/ChatMobileSidebarButton.svelte) shows a small red dot when unread chat or welcome-notification attention is pending.

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
