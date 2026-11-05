import { getHighlightSources } from '$lib/chat/highlights';

export interface HighlightSource {
	readonly label: string;
	readonly href?: string;
}

/**
 * Resolve the first usable source reference of a NIP-84 highlight to a card
 * footer link. Kept as the compact single-source view over the richer
 * `getHighlightSources()` parser; malformed references are skipped rather than
 * fatal.
 */
export function highlightSource(tags: string[][]): HighlightSource | null {
	const source = getHighlightSources(tags)[0];
	if (!source) return null;
	return source.type === 'text'
		? { label: source.label }
		: { label: source.label, href: source.href };
}
