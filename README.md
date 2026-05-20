# cordn-web

[`cordn-web`](package.json) is the web client for Cordn.

It is built with SvelteKit, Svelte 5, TypeScript, and Tailwind CSS, and currently includes:

- a landing page at [`/`](src/routes/+page.svelte)
- a browser chat UI at [`/chat`](src/routes/chat/+page.svelte)
- route-based group navigation under [`src/routes/chat/[id]`](src/routes/chat/[id])

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
