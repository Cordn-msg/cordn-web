/**
 * Writes `static/version.json` from the current git short SHA (with a
 * timestamp fallback when git is unavailable). Runs automatically before
 * `pnpm build` via the `prebuild` script.
 *
 * `vite.config.ts` reads the same value to stamp `__APP_VERSION__` into the
 * client bundle, so the running bundle and the deployed marker always share a
 * source. Only `version` is compared for update detection; `builtAt` is for
 * human display/debugging.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

function resolveVersion() {
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return `dev-${Date.now().toString(36)}`;
	}
}

const payload = { version: resolveVersion(), builtAt: new Date().toISOString() };

mkdirSync('static', { recursive: true });
writeFileSync('static/version.json', `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

console.log(`[write-version] static/version.json <- ${JSON.stringify(payload)}`);
