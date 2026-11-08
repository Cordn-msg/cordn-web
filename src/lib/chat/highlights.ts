import { naddrEncode, neventEncode } from 'nostr-tools/nip19';
import type { AddressPointer } from 'nostr-tools/nip19';
import { parseNostrAddress } from './nostrAddress';

/**
 * NIP-84 highlight (kind 9802) parsing helpers.
 *
 * The highlighted text is the event `content`; an optional `context` tag holds
 * the surrounding prose. Sources live in tags: `e` for an event id, `a` for an
 * addressable Nostr event (long-form articles are kind 30023), `r`/`i` for an
 * external URL or free-text source.
 */

export interface ChatHighlightNostrSource {
	type: 'nostr';
	label: string;
	href: string;
	/** Canonical nevent/naddr for copying/opening the source. */
	entity: string;
	/** Present for addressable (`a` tag) sources. */
	pointer?: AddressPointer;
}

export interface ChatHighlightLinkSource {
	type: 'link';
	label: string;
	href: string;
}

export interface ChatHighlightTextSource {
	type: 'text';
	label: string;
}

export type ChatHighlightSource =
	| ChatHighlightNostrSource
	| ChatHighlightLinkSource
	| ChatHighlightTextSource;

export interface ChatHighlightContextParts {
	before: string;
	highlight: string;
	after: string;
}

export function getHighlightContext(tags: string[][]): string | undefined {
	const value = tags.find((tag) => tag[0] === 'context')?.[1];
	return value?.trim() || undefined;
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/**
 * Sources in tag order, de-duplicated. Malformed references are skipped so a
 * later usable source tag still gets its chance. `r` tags carrying the
 * `mention` attribute are comment mentions, not sources, and are ignored.
 */
export function getHighlightSources(tags: string[][]): ChatHighlightSource[] {
	const sources: ChatHighlightSource[] = [];
	const seen = new Set<string>();

	const add = (source: ChatHighlightSource) => {
		const key =
			source.type === 'text'
				? `text:${source.label}`
				: source.type === 'nostr'
					? source.pointer
						? `nostr:${source.pointer.kind}:${source.pointer.pubkey}:${source.pointer.identifier}`
						: `nostr:${source.entity}`
					: source.href;
		if (seen.has(key)) return;
		seen.add(key);
		sources.push(source);
	};

	for (const [name, value, attribute] of tags) {
		if (!value) continue;
		try {
			if (name === 'e') {
				const entity = neventEncode({ id: value });
				add({
					type: 'nostr',
					label: 'Nostr event',
					href: `https://nostr.at/${entity}`,
					entity
				});
			} else if (name === 'a') {
				const pointer = parseNostrAddress(value, attribute);
				if (!pointer) continue;
				const entity = naddrEncode(pointer);
				add({
					type: 'nostr',
					label: 'Nostr article',
					href: `https://nostr.at/${entity}`,
					entity,
					pointer
				});
			} else if (name === 'r' || name === 'i') {
				if (attribute === 'mention') continue;
				if (/^https?:\/\//i.test(value)) {
					add({ type: 'link', label: hostnameOf(value), href: value });
				} else {
					add({ type: 'text', label: value });
				}
			}
		} catch {
			// Malformed reference: fall through to the next source tag.
		}
	}

	return sources;
}

/**
 * Split the surrounding `context` around the highlighted text so the renderer
 * can dim only the leading/trailing prose. Returns null when the highlight is
 * not found verbatim in the context (or either side is missing).
 */
export function splitHighlightContext(
	context: string | undefined,
	highlight: string
): ChatHighlightContextParts | null {
	if (!context) return null;
	const needle = highlight.trim();
	if (!needle) return null;

	const index = context.indexOf(needle);
	if (index < 0) return null;

	return {
		before: context.slice(0, index),
		highlight: needle,
		after: context.slice(index + needle.length)
	};
}
