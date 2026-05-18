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
- Prefer small, focused Svelte components and keep route files thin.
- Group message ingestion is centralized in [`applyIncomingChatGroupMessages()`](src/lib/services/chatGroups.svelte.ts:379) so manual fetches via [`fetchChatGroupMessages()`](src/lib/services/chatGroups.svelte.ts:419) and live subscriptions via [`ingestIncomingChatGroupMessages()`](src/lib/services/chatGroups.svelte.ts:449) stay consistent.
- Active group watching is managed in [`startWatchingGroup()`](src/lib/services/chatGroupWatch.svelte.ts:71) and should remain the default path for keeping an open chat route up to date instead of adding parallel fetch-heavy flows.

## Code style

- Follow Svelte 5 patterns and runes where appropriate.
- Use TypeScript in Svelte and helper modules.
- Keep styling in Tailwind utility classes; reuse existing UI components before adding raw HTML controls.
- Before finishing changes, run [`pnpm lint`](package.json:15) and [`pnpm check`](package.json:11).

## Testing and validation

- Unit tests use Vitest via [`pnpm test`](package.json:20).
- For UI and type safety changes, always run [`pnpm check`](package.json:11).
- For formatting and ESLint validation, run [`pnpm lint`](package.json:15).

## PR and change guidance

- Keep changes minimal and consistent with the existing structure.
- Avoid broad refactors unless required for the task.
- When touching chat flows, preserve route-based group behavior under [`src/routes/chat/[id]`](src/routes/chat/[id]).
