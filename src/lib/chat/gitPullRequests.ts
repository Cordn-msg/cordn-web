import { kinds } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';
import { naddrEncode } from 'nostr-tools/nip19';
import type { AddressPointer } from 'nostr-tools/nip19';
import { parseNostrAddress } from './nostrAddress';

/**
 * NIP-34 pull request (kind 1618) parsing helpers.
 *
 * The PR title is the `subject` tag, while `content` is its Markdown
 * description. The target repository is an `a` tag pointing at a kind-30617
 * repository announcement; `branch-name`, `c`, and `clone` describe the
 * proposed branch and commit.
 */

export interface ChatGitPullRequestRepository {
	pointer: AddressPointer;
	/** Canonical naddr for opening the repository announcement. */
	naddr: string;
	identifier: string;
}

export interface ChatGitPullRequest {
	subject: string;
	description: string;
	repository: ChatGitPullRequestRepository | null;
	branchName: string;
	targetBranch: string;
	commit: string;
	cloneUrls: string[];
	labels: string[];
}

export interface ChatGitRepository {
	identifier: string;
	name: string;
	webUrls: string[];
}

function tagValue(tags: string[][], name: string): string {
	return tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? '';
}

function allTagValues(tags: string[][], name: string): string[] {
	return tags
		.filter((tag) => tag[0] === name)
		.flatMap((tag) => tag.slice(1))
		.map((value) => value.trim())
		.filter(Boolean);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

const WEB_PROTOCOLS = new Set(['http:', 'https:']);
// Clone tags may legitimately use HTTPS, SSH, or the legacy git protocol.
// Other schemes are still copied nowhere and opened nowhere — drop them at the
// parser boundary so untrusted events cannot smuggle in a surprising URL.
const CLONE_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:']);

function hasAllowedProtocol(value: string, protocols: Set<string>): boolean {
	try {
		return protocols.has(new URL(value).protocol);
	} catch {
		return false;
	}
}

function filterWebUrls(values: string[]): string[] {
	return unique(values.filter((value) => hasAllowedProtocol(value, WEB_PROTOCOLS)));
}

function filterCloneUrls(values: string[]): string[] {
	return unique(values.filter((value) => hasAllowedProtocol(value, CLONE_PROTOCOLS)));
}

function parseRepository(tags: string[][]): ChatGitPullRequestRepository | null {
	for (const [name, value, relayHint] of tags) {
		if (name !== 'a' || !value) continue;
		const pointer = parseNostrAddress(value, relayHint);
		if (!pointer || pointer.kind !== kinds.RepositoryAnnouncement) continue;
		return {
			pointer,
			naddr: naddrEncode(pointer),
			identifier: pointer.identifier
		};
	}
	return null;
}

export function parseGitPullRequest(tags: string[][], description = ''): ChatGitPullRequest {
	return {
		subject: tagValue(tags, 'subject'),
		description,
		repository: parseRepository(tags),
		branchName: tagValue(tags, 'branch-name'),
		targetBranch: tagValue(tags, 'target-branch'),
		commit: tagValue(tags, 'c'),
		cloneUrls: filterCloneUrls(allTagValues(tags, 'clone')),
		labels: unique(allTagValues(tags, 't'))
	};
}

/**
 * Read the presentation fields of a kind-30617 repository announcement.
 * `fallbackIdentifier` covers a loaded announcement with an empty `d` tag; the
 * component separately falls back to the PR's `a` tag identifier before the
 * announcement itself has loaded.
 */
export function parseGitRepository(
	event: NostrEvent | undefined,
	fallbackIdentifier = ''
): ChatGitRepository | null {
	if (!event || event.kind !== kinds.RepositoryAnnouncement) return null;

	const identifier = tagValue(event.tags, 'd') || fallbackIdentifier;
	if (!identifier) return null;

	return {
		identifier,
		name: tagValue(event.tags, 'name') || identifier,
		webUrls: filterWebUrls(allTagValues(event.tags, 'web'))
	};
}
