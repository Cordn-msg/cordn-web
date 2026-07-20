/**
 * Prepends a section to CHANGELOG.md for the current release, generated from the Conventional
 * Commits (`type(scope): subject`) between the previous tag and HEAD. Runs in the `version`
 * lifecycle hook (defined in package.json) after `pnpm version` bumps package.json and before
 * git commits, then stages the file so it lands inside the release commit + tag. No deps.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const git = (args) => {
	try {
		return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
	} catch {
		return '';
	}
};

// HEAD is the version-bump commit `pnpm version` just made; HEAD^'s nearest tag is the previous
// release. If none exists (first cut), we emit a stub instead of dumping the entire history.
const prevTag = git('describe --tags --abbrev=0 HEAD^');

const date = new Date().toISOString().slice(0, 10);
let body;
if (!prevTag) {
	body = '_First tracked release; prior history is in git._';
} else {
	const log = git(`log --format=%s ${prevTag}..HEAD`);
	const RE = /^(\w+)(?:\(([^)]+)\))?:\s+(.+)$/;
	const GROUPS = [
		['feat', 'Features'],
		['fix', 'Fixes'],
		['perf', 'Performance'],
		['docs', 'Docs'],
		['refactor', 'Refactor'],
		['chore', 'Chore']
	];
	const buckets = new Map(GROUPS.map(([k]) => [k, []]));
	const other = [];
	for (const line of log.split('\n').filter(Boolean)) {
		const m = line.match(RE);
		if (!m) continue; // skip merges + the bare version-bump commit ("0.2.0")
		const [, type, scope, subject] = m;
		const entry = `- ${scope ? `**${scope}:** ` : ''}${subject}`;
		if (buckets.has(type)) buckets.get(type).push(entry);
		else other.push(entry); // test/ci/build/style + unknown prefixes
	}
	const parts = [];
	for (const [, label] of GROUPS) {
		const items = buckets.get(label === 'Features' ? 'feat' : GROUPS.find((g) => g[1] === label)[0]);
		if (items?.length) parts.push(`### ${label}\n\n${items.join('\n')}`);
	}
	if (other.length) parts.push(`### Other\n\n${other.join('\n')}`);
	body = parts.join('\n\n') || '_No notable changes._';
}

const section = `## ${version} — ${date}\n\n${body}\n`;
const HEADER = '# Changelog\n\n';
const existing = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : '';
const tail = existing.startsWith(HEADER) ? existing.slice(HEADER.length) : existing;
writeFileSync('CHANGELOG.md', HEADER + section + (tail ? `\n${tail}` : ''));

// Stage so the changelog ships inside the release commit (the `version` hook runs pre-commit).
git('add CHANGELOG.md');
console.log(`[changelog] CHANGELOG.md <- ${version} (${prevTag ? `since ${prevTag}` : 'initial'})`);
