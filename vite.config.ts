import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Resolve the build version baked into the client bundle. This must match the
 * version written to `static/version.json` by `scripts/write-version.mjs`
 * (both derive from `git rev-parse --short HEAD`). At build time `prebuild`
 * runs first, so we prefer the file it wrote; in `pnpm dev` we fall back to
 * reading git directly.
 */
function resolveAppVersion(): string {
	try {
		const parsed = JSON.parse(readFileSync('static/version.json', 'utf8')) as { version?: unknown };
		if (parsed && typeof parsed.version === 'string') return parsed.version;
	} catch {
		// file not present (e.g. dev before prebuild) — fall through to git
	}
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return `dev-${Date.now().toString(36)}`;
	}
}

const appVersion = resolveAppVersion();

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(appVersion)
	},
	plugins: [tailwindcss(), sveltekit()],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
