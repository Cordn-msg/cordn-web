import { describe, expect, test } from 'vitest';
import type { NostrEvent } from 'nostr-tools';

import { parseGitPullRequest, parseGitRepository } from './gitPullRequests';

const REPO_OWNER = 'c3c6d9bb385fd827cfdb45d933a1e8ccf2905be30467151ed5fe356a10a525e9';
const REPO_ADDRESS = `30617:${REPO_OWNER}:cordn-web`;
const PR_TAGS = [
	['a', REPO_ADDRESS, 'wss://relay.ngit.dev'],
	['subject', 'feat(chat): enrich NIP-84 highlight embeds'],
	['alt', 'git Pull Request: feat(chat): enrich NIP-84 highlight embeds'],
	['branch-name', 'highlight-source-context'],
	['r', '01ecc14ed751e33f4c60bdbd7c18048de458d93d'],
	['c', '4196aafed563ec3168e1374f7ccdf94eb28d8856'],
	[
		'clone',
		'https://relay.ngit.dev/npub1c0rdnwectlvz0n7mghvn8g0genefqklrq3n328k4lc6k5y99yh5s640tlv/cordn-web.git',
		'https://gitnostr.com/npub1c0rdnwectlvz0n7mghvn8g0genefqklrq3n328k4lc6k5y99yh5s640tlv/cordn-web.git'
	],
	['merge-base', '0989ba851f3bb8275a85de8e08e35ec543af6656'],
	['p', REPO_OWNER]
];
const PR_DESCRIPTION =
	'Render all NIP-84 highlight sources, show the source article title, and split/dim context around the quoted excerpt.';

describe('NIP-34 pull request parsing', () => {
	test('reads the subject, repository, branch, commit, clone URLs and labels', () => {
		const pr = parseGitPullRequest(
			[...PR_TAGS, ['t', 'feature'], ['t', 'feature'], ['t', 'nostr']],
			PR_DESCRIPTION
		);

		expect(pr.subject).toBe('feat(chat): enrich NIP-84 highlight embeds');
		expect(pr.description).toBe(PR_DESCRIPTION);
		expect(pr.repository).toMatchObject({ identifier: 'cordn-web' });
		expect(pr.repository?.naddr).toMatch(/^naddr1/);
		expect(pr.branchName).toBe('highlight-source-context');
		expect(pr.targetBranch).toBe('');
		expect(pr.commit).toBe('4196aafed563ec3168e1374f7ccdf94eb28d8856');
		expect(pr.cloneUrls).toEqual([
			'https://relay.ngit.dev/npub1c0rdnwectlvz0n7mghvn8g0genefqklrq3n328k4lc6k5y99yh5s640tlv/cordn-web.git',
			'https://gitnostr.com/npub1c0rdnwectlvz0n7mghvn8g0genefqklrq3n328k4lc6k5y99yh5s640tlv/cordn-web.git'
		]);
		expect(pr.labels).toEqual(['feature', 'nostr']);
	});

	test('keeps a target branch when the PR declares one', () => {
		const pr = parseGitPullRequest([['target-branch', 'release/2.x']]);
		expect(pr.targetBranch).toBe('release/2.x');
	});

	test('drops unsafe clone URLs from the PR footer actions', () => {
		const pr = parseGitPullRequest([
			['clone', 'javascript:alert(1)'],
			['clone', 'https://example.com/repo.git'],
			['clone', 'ssh://git@example.com/repo.git']
		]);
		expect(pr.cloneUrls).toEqual([
			'https://example.com/repo.git',
			'ssh://git@example.com/repo.git'
		]);
	});

	test('skips malformed or non-repository a-tags', () => {
		const pr = parseGitPullRequest([
			['a', 'not-an-address'],
			['a', '30023:pubkey:article'],
			['a', REPO_ADDRESS, 'wss://relay.ngit.dev']
		]);
		expect(pr.repository?.identifier).toBe('cordn-web');
	});

	test('returns empty presentation fields for a sparse PR', () => {
		const pr = parseGitPullRequest([]);
		expect(pr).toEqual({
			subject: '',
			description: '',
			repository: null,
			branchName: '',
			targetBranch: '',
			commit: '',
			cloneUrls: [],
			labels: []
		});
	});
});

describe('NIP-34 repository announcement parsing', () => {
	test('reads name and web URL', () => {
		const event = {
			kind: 30617,
			tags: [
				['d', 'cordn-web'],
				['name', 'cordn-web'],
				['description', ''],
				['clone', 'https://relay.ngit.dev/repo.git'],
				['web', 'https://gitworkshop.dev/repo'],
				['relays', 'wss://relay.ngit.dev', 'wss://gitnostr.com']
			]
		} as NostrEvent;

		expect(parseGitRepository(event)).toEqual({
			identifier: 'cordn-web',
			name: 'cordn-web',
			webUrls: ['https://gitworkshop.dev/repo']
		});
	});

	test('drops unsafe web URLs from repository announcements', () => {
		const event = {
			kind: 30617,
			tags: [
				['d', 'cordn-web'],
				['web', 'javascript:alert(1)'],
				['web', 'https://gitworkshop.dev/repo']
			]
		} as NostrEvent;

		expect(parseGitRepository(event)?.webUrls).toEqual(['https://gitworkshop.dev/repo']);
	});

	test('uses the PR address identifier when the announcement d tag is empty', () => {
		expect(parseGitRepository(undefined, 'cordn-web')).toBeNull();

		const event = { kind: 30617, tags: [['d', '']] } as NostrEvent;
		expect(parseGitRepository(event, 'cordn-web')?.identifier).toBe('cordn-web');
		expect(parseGitRepository(event, 'cordn-web')?.name).toBe('cordn-web');
	});

	test('ignores events that are not repository announcements', () => {
		expect(parseGitRepository({ kind: 1, tags: [['d', 'cordn-web']] } as NostrEvent)).toBeNull();
	});
});
