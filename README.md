# cordn-web

[`cordn-web`](package.json) is the web client for Cordn.

It is built with SvelteKit, Svelte 5, TypeScript, and Tailwind CSS, and currently includes:

- a landing page at [`/`](src/routes/+page.svelte)
- a browser chat UI at [`/chat`](src/routes/chat/+page.svelte)
- route-based group navigation under [`src/routes/chat/[id]`](src/routes/chat/[id])

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
