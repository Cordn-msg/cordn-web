import type { ChatMessage } from './chat.types';

/**
 * The full reaction-marker pipeline, in order: prune first (per-row, so a
 * burst that touches the adjacent message only loses those rows), then merge
 * (so one sender's surviving burst rows collapse into one). Order matters —
 * merging first lets an adjacent first target swallow a whole run.
 */
export function foldReactionMarkers(rows: ChatMessage[]): ChatMessage[] {
	return mergeAdjacentReactionMarkers(pruneAdjacentReactionTargets(rows));
}

/**
 * Post-prune pass for reaction markers: merges ADJACENT reaction-marker rows
 * that share the same target into one row ("Alice, Bob +3 reacted 👍 ❤️ — See"),
 * and rows from the SAME SENDER even across different targets (one user's
 * burst of reactions on several messages collapses to one row), so a burst of
 * reactions doesn't flood the timeline with near-identical marker rows. Rows
 * keep the span position the run occupied in the sorted array; the merged
 * row's id comes from the FIRST member (stable virtualizer key when the run
 * grows at its end) while createdAt and timeLabel reflect the LAST member
 * (most recent activity). The merged row keeps its members in `reactionItems`
 * (first to last) so the UI can expand the summary and give each member its
 * own jump to its own target.
 *
 * Rows without a target never merge — each keeps its own row (no jump offered).
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
			previous.reactionTarget &&
			(row.reactionTarget === previous.reactionTarget ||
				(row.reactionSenders ?? []).some((sender) => previous.reactionSenders?.includes(sender)))
		) {
			out[out.length - 1] = {
				...previous,
				createdAt: row.createdAt,
				timeLabel: row.timeLabel,
				reactionEmojis: [
					...new Set([...(previous.reactionEmojis ?? []), ...(row.reactionEmojis ?? [])])
				],
				reactionEmojiViews: {
					...(previous.reactionEmojiViews ?? {}),
					...(row.reactionEmojiViews ?? {})
				},
				reactionSenders: [
					...new Set([...(previous.reactionSenders ?? []), ...(row.reactionSenders ?? [])])
				],
				reactionItems: [...(previous.reactionItems ?? [previous]), row]
			};
			continue;
		}
		out.push(row);
	}
	return out;
}

/**
 * First pipeline pass: drops a reaction row when its target is the nearest
 * preceding MESSAGE in the list — the reaction chips on that message are
 * right there, so the row only duplicates them. Fate depends only on a row's
 * neighborhood (appending newer messages never resurrects dropped rows),
 * which is why the merge runs after this pass and only sees survivors.
 * Non-system entries advance the tracker (pending `outbox:` ids can never
 * match a reaction target, so they are harmless); other system rows are
 * skipped — they can't be targets.
 */
export function pruneAdjacentReactionTargets(rows: ChatMessage[]): ChatMessage[] {
	let lastMessageId: string | undefined;
	const out: ChatMessage[] = [];
	for (const row of rows) {
		if (row.systemKind && row.systemKind !== 'reaction') {
			out.push(row);
			continue;
		}
		if (row.systemKind === 'reaction') {
			if (row.reactionTarget && row.reactionTarget === lastMessageId) continue;
			out.push(row);
			continue;
		}
		lastMessageId = row.id;
		out.push(row);
	}
	return out;
}
