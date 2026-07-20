/**
 * Writes `static/version.json` carrying TWO distinct values (see docs/versioning.md):
 *  - `version`: the git short SHA — the per-build deploy-change token consumed by
 *    `appUpdate.svelte.ts` (must change on every build; semver is too coarse).
 *  - `semver`:  the product version from package.json — for user-facing display + Android
 *    versionName. This is the single source of truth bumped by `pnpm version`.
 * `vite.config.ts` reads the same file to stamp `__APP_VERSION__` (SHA) and `__APP_SEMVER__` into
 * the client bundle, so the running bundle and the deployed marker always share a source. Runs
 * automatically before `pnpm build` via the `prebuild` script.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

function resolveSha() {
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return `dev-${Date.now().toString(36)}`;
	}
}

const { version: semver } = JSON.parse(readFileSync('package.json', 'utf8'));

const payload = { version: resolveSha(), semver, builtAt: new Date().toISOString() };

mkdirSync('static', { recursive: true });
writeFileSync('static/version.json', `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

console.log(`[write-version] static/version.json <- ${JSON.stringify(payload)}`);
