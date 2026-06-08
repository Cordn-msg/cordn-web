import { nip19 } from 'nostr-tools';

export interface SearchKeyword {
	/** The keyword token that follows '@' (e.g., "me"). */
	trigger: string;
	/** Display label shown in the autocomplete dropdown. */
	label: string;
	/** Short description shown in the autocomplete dropdown. */
	description: string;
}

const SEARCH_KEYWORDS = [
	{ trigger: 'me', label: 'me', description: 'Search for messages that reference you' }
] as const satisfies readonly SearchKeyword[];

/** Returns all registered search keywords for autocomplete suggestions. */
export function getSearchKeywords(): readonly SearchKeyword[] {
	return SEARCH_KEYWORDS;
}

/**
 * Expands `@me` in the search query into one or more literal search terms.
 * When profile names are available, produces multiple search strings so that
 * the query matches messages containing the user's npub OR any profile name.
 *
 * Returns a plain string when no keywords need expansion; returns a string
 * array when `@me` expands into multiple search targets.
 */
export function resolveSearchQuery(
	query: string,
	activePubkey?: string | null,
	profileNames?: string[]
): string | string[] {
	if (!activePubkey) return query;

	const hasMe = /(?:^|\s)@me\b/i.test(query);
	if (!hasMe) return query;

	const npub = nip19.npubEncode(activePubkey);
	const rawNames = (profileNames ?? []).map((n) => n.trim()).filter((n) => n.length > 0);
	const seen = new Set<string>();
	const names: string[] = [];
	for (const name of rawNames) {
		const lower = name.toLocaleLowerCase();
		if (!seen.has(lower)) {
			seen.add(lower);
			names.push(name);
		}
	}
	const terms = [npub, ...names.filter((n) => n.toLocaleLowerCase() !== npub.toLocaleLowerCase())];

	if (terms.length <= 1) {
		return query.replace(/(^|\s)@me\b/gi, (_, prefix) => `${prefix}${npub}`);
	}

	return terms.map((term) => query.replace(/(^|\s)@me\b/gi, (_, prefix) => `${prefix}${term}`));
}
