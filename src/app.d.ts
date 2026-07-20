// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	// Build-time version stamps injected by Vite `define` (see vite.config.ts), sourced from
	// `static/version.json`. `__APP_VERSION__` is the git SHA (per-build deploy-change token);
	// `__APP_SEMVER__` is the product version for user-facing display. See docs/versioning.md.
	const __APP_VERSION__: string;
	const __APP_SEMVER__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
