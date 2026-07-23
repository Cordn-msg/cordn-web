import type { PageLoad } from './$types';

/**
 * Web Share Target GET transport: when an installed PWA receives a share, the browser navigates
 * here with `?title&text&url`. The native SEND-intent transport is NOT read here — it is drained
 * in `+page.svelte` on mount via `consumeStashedShare()` (this load runs client-side since
 * `ssr = false`, but keeping the two transports split keeps the seam clear).
 *
 * Combines the params the way a messaging user expects: caption + link become two lines; a bare
 * link or bare text passes through unchanged.
 */
function combineShare(text?: string, url?: string, title?: string): string | null {
	const t = text?.trim();
	const u = url?.trim();
	const titleT = title?.trim();
	if (t && u && !t.includes(u)) return `${t}\n${u}`;
	return (t || u || titleT) || null;
}

export const load: PageLoad = ({ url }) => {
	const text = combineShare(
		url.searchParams.get('text') ?? undefined,
		url.searchParams.get('url') ?? undefined,
		url.searchParams.get('title') ?? undefined
	);
	return { text };
};
