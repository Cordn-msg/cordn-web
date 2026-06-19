# AGENTS.md

## Project overview

[`cordn-web`](package.json) is a SvelteKit frontend for Cordn. It currently contains a landing page plus a browser chat UI under [`src/routes/chat`](src/routes/chat). The stack is Svelte 5, TypeScript, Tailwind CSS 4, and shadcn-svelte-style UI components under [`src/lib/components/ui`](src/lib/components/ui).

## Setup and development commands

- Install dependencies: `pnpm install`
- Start dev server: `pnpm dev`
- Build production app: `pnpm build`
- Preview production build: `pnpm preview`
- Type and Svelte checks: `pnpm check`
- Lint: `pnpm lint`
- Auto-fix formatting/lint issues: `pnpm lint:fix`
- Run unit tests: `pnpm test`

## Development workflow

- Use `pnpm` for all package management and scripts.
- Main app routes live in [`src/routes`](src/routes).
- Shared UI primitives live in [`src/lib/components/ui`](src/lib/components/ui).
- Chat-specific UI lives in [`src/lib/components/chat`](src/lib/components/chat).
- User profile pages live under [`src/routes/p`](src/routes/p) and should stay focused on profile presentation plus local shared-group discovery.
- Chat persistence is centralized behind [`getChatStorage()`](src/lib/storage/chatStorage.ts:530) with IndexedDB as the primary backend and local-storage/memory fallbacks.
- Group records persist MLS state bytes, message history, sync issues, and the [`joinEpoch`](src/lib/storage/chatStorage.ts:20) through [`src/lib/storage/chatStorage.ts`](src/lib/storage/chatStorage.ts) rather than direct localStorage blobs.
- Key package persistence is handled through the same storage layer, with binary package material converted at the service boundary in [`src/lib/services/chatKeyPackages.svelte.ts`](src/lib/services/chatKeyPackages.svelte.ts:1).
- The key package config route in [`src/routes/chat/config/key-packages/+page.svelte`](src/routes/chat/config/key-packages/+page.svelte) should stay forgiving of stale coordinator removals and prefer locally derived group-usage details on key package cards instead of extra remote reads.
- Prefer small, focused Svelte components and keep route files thin.
- Keep private-key UX minimal: when adjusting [`AccountLoginDialog.svelte`](src/lib/components/AccountLoginDialog.svelte), prefer simple local reveal/hide behavior over additional backup flows.
- Group message ingestion is centralized in [`applyIncomingChatGroupMessages()`](src/lib/services/chatGroups.svelte.ts:379) so manual fetches via [`fetchChatGroupMessages()`](src/lib/services/chatGroups.svelte.ts:419) and live subscriptions via [`ingestIncomingChatGroupMessages()`](src/lib/services/chatGroups.svelte.ts:449) stay consistent.
- Active group watching is managed in [`startWatchingGroup()`](src/lib/services/chatGroupWatch.svelte.ts:71) and should remain the default path for keeping an open chat route up to date instead of adding parallel fetch-heavy flows.
- Long group histories are virtualized with [`@tanstack/svelte-virtual`](package.json:65) in [`ChatMessageList.svelte`](src/lib/components/chat/ChatMessageList.svelte:55). Preserve [`scrollToMessage()`](src/lib/components/chat/ChatMessageList.svelte:75), stable message keys, and [`data-message-id`](src/lib/components/chat/ChatMessageList.svelte:212) anchors when changing reference, mention, or unread navigation behavior.
- Chat message render optimizations live in [`chatMessageRenderCache.ts`](src/lib/components/chat/chatMessageRenderCache.ts:1) and [`ChatMessageItem.svelte`](src/lib/components/chat/ChatMessageItem.svelte:1). Keep expensive derived text parsing cached, avoid per-row localStorage effects, and lazily mount menu/tooltip-heavy controls when extending message actions.
- Browser unread/title/notification behavior is centralized in [`src/lib/services/chatAttention.svelte.ts`](src/lib/services/chatAttention.svelte.ts). Keep tab-title counts, browser notification dispatch, and mobile sidebar attention indicators derived from the same unread sources instead of duplicating route-local logic.

## Fetching and caching strategy

- The project uses `@tanstack/svelte-query` as a **remote coordinator cache and async orchestration layer**, not as a replacement for local durable chat state.
- All query configuration lives in [`src/lib/query-client.ts`](src/lib/query-client.ts). The root layout wraps the app in [`QueryClientProvider`](src/routes/+layout.svelte:16).
- Query keys are centralized in [`src/lib/queries/chatQueryKeys.ts`](src/lib/queries/chatQueryKeys.ts) and must be used for every Svelte Query read or invalidation. Query keys include the active stable pubkey to prevent cross-account cache leakage.
- The query key structure supports `undefined` coordinator keys via a dedicated `'all-coordinators'` segment so the same key tree can represent both per-coordinator and cross-coordinator lookups.
- Remote reads currently managed through Svelte Query:
  - **Available key packages** — fetched via [`fetchCoordinatorAvailableKeyPackages()`](src/lib/queries/chatKeyPackageQueries.ts:8) and consumed by [`listCoordinatorAvailableKeyPackages()`](src/lib/services/chatGroups.svelte.ts:369), [`reconcilePublishedKeyPackagesForActiveAccount()`](src/lib/services/chatKeyPackages.svelte.ts:312), and the coordinator detail UI.
  - **Welcome notifications** — fetched via [`welcomeNotificationsQueryOptions()`](src/lib/queries/chatWelcomeQueries.ts:9) with `refetchInterval`-based polling. The coordinator now uses TTL-based non-destructive welcome storage, so accepted and dismissed welcomes are retained locally to prevent reappearance across fetches.
- Svelte Query owns **remote read caching, deduplication, and in-flight request sharing**. The existing stores and IndexedDB layer continue to own durable local state.
- For profile pages, prefer deriving shared-group membership from existing local group state before introducing new Svelte Query reads.
- These coordinator operations are **not** moved into Svelte Query because they are mutations, streaming state, or durable local writes:
  - [`PublishKeyPackage`](src/lib/services/coordinatorClient.ts:197), [`RemoveKeyPackages`](src/lib/services/coordinatorClient.ts:220), [`ConsumeKeyPackage`](src/lib/services/coordinatorClient.ts:211), [`PostGroupMessage`](src/lib/services/coordinatorClient.ts:278), [`StoreWelcome`](src/lib/services/coordinatorClient.ts:264), [`FetchGroupMessages`](src/lib/services/coordinatorClient.ts:293), and [`SubscribeGroupMessages`](src/lib/services/coordinatorClient.ts:302).
- All fetch/subscribe call sites pass [`since_epoch`](src/lib/contracts/index.ts:112) — derived from [`joinEpoch`](src/lib/services/chatGroups.svelte.ts:89) via [`toWatchableGroup`](src/lib/services/chatGroupWatch.svelte.ts:330) — so the coordinator filters out pre-join messages that are undecryptable. The group creator defaults to `0n` (no filter). When touching fetch/subscribe logic in [`chatGroupWatch.svelte.ts`](src/lib/services/chatGroupWatch.svelte.ts), preserve `sinceEpoch` in every request path.
- Invalidation rules:
  - After publishing, removing, or consuming a key package, invalidate the matching `available-key-packages` query key.
  - After account change, remove all queries scoped to the previous account via [`queryClient.removeQueries()`](src/lib/services/chatGroupWatch.svelte.ts:82).
- When adding new remote-read queries, follow the same pattern: centralize keys in [`chatQueryKeys`](src/lib/queries/chatQueryKeys.ts), add fetch helpers in `src/lib/queries/`, and wire invalidation in the service layer that performs the mutation.

## Code style

- Follow Svelte 5 patterns and runes where appropriate.
- Use TypeScript in Svelte and helper modules.
- Keep styling in Tailwind utility classes; reuse existing UI components before adding raw HTML controls.
- Before finishing changes, run [`pnpm lint`](package.json:15) and [`pnpm check`](package.json:11).
- Avoid running `pnpm lint:fix` or Prettier auto-formatting unless explicitly requested. Formatting is done manually, at the end of the session.

## Testing and validation

- Unit tests use Vitest via [`pnpm test`](package.json:20).
- For UI and type safety changes, always run [`pnpm check`](package.json:11).
- For formatting and ESLint validation, run [`pnpm lint`](package.json:15).

## PR and change guidance

- Keep changes minimal and consistent with the existing structure.
- Avoid broad refactors unless required for the task.
- When touching chat flows, preserve route-based group behavior under [`src/routes/chat/[id]`](src/routes/chat/[id]).
