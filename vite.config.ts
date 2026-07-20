import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Build-time version stamps injected via Vite `define`. Two distinct values (see docs/versioning.md):
 *  - `appSha`    → `__APP_VERSION__`: per-build git SHA. Drives web deploy-change detection in
 *                  appUpdate.svelte.ts (must change on every deploy; semver is too coarse).
 *  - `appSemver` → `__APP_SEMVER__`: product version from package.json, for user-facing display.
 * Both prefer `static/version.json` (written by scripts/write-version.mjs at prebuild) and fall
 * back to git / package.json directly so `pnpm dev` works before prebuild has run.
 */
function readVersionJson(): { version?: unknown; semver?: unknown } {
	try {
		return JSON.parse(readFileSync('static/version.json', 'utf8'));
	} catch {
		return {};
	}
}

const versionJson = readVersionJson();

function resolveAppSha(): string {
	if (typeof versionJson.version === 'string') return versionJson.version;
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return `dev-${Date.now().toString(36)}`;
	}
}

function resolveAppSemver(): string {
	if (typeof versionJson.semver === 'string') return versionJson.semver;
	try {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown };
		if (typeof pkg.version === 'string') return pkg.version;
	} catch {
		// package.json unreadable — fall through
	}
	return '0.0.0';
}

const appSha = resolveAppSha();
const appSemver = resolveAppSemver();

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(appSha),
		__APP_SEMVER__: JSON.stringify(appSemver)
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
