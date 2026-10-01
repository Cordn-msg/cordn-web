import type { ChatMessage } from './chat.types';

/**
 * Post-sort pass for reaction markers: merges ADJACENT reaction-marker rows
 * that share the same target into one row ("Alice, Bob +3 reacted 👍 ❤️ — See"),
 * so a burst of reactions on one message doesn't flood the timeline with
 * near-identical marker rows. Rows keep the span position the run occupied in
 * the sorted array; the merged row's id/createdAt come from the FIRST member
 * (stable virtualizer key when the run grows at its end) while timeLabel
 * reflects the LAST member (most recent activity).
 *
 * Rows without a target never merge — each keeps its own row (no See button).
 */
export function mergeAdjacentReactionMarkers(rows: ChatMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const row of rows) {
		const previous = out.at(-1);
		if (
			previous &&
			row.systemKind === 'reaction' &&
			previous.systemKind === 'reaction' &&
			row.reactionTarget &&
			row.reactionTarget === previous.reactionTarget
		) {
			out[out.length - 1] = {
				...previous,
				createdAt: row.createdAt,
				timeLabel: row.timeLabel,
				reactionEmojis: [
					...new Set([...(previous.reactionEmojis ?? []), ...(row.reactionEmojis ?? [])])
				],
				reactionSenders: [
					...new Set([...(previous.reactionSenders ?? []), ...(row.reactionSenders ?? [])])
				]
			};
			continue;
		}
		out.push(row);
	}
	return out;
}
