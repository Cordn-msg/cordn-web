/**
 * Kind catalog and categorization for chat messages.
 *
 * Single source of truth for every kind number. Import from here — never inline
 * a magic number. See `src/lib/chat/README.md` for the rendering model.
 */

/** Synthetic, non-Nostr messages derived from MLS commits (member add/remove,
 *  metadata changes). Carried in the same `kind` field as real Nostr kinds. */
export const SYSTEM_MESSAGE_KIND = -1;

/** Real Nostr/Cordn application kinds rendered in the chat. */
export const ChatKinds = {
	Text: 9,
	ThreadReply: 1111,
	Reaction: 7,
	Edit: 1010,
	Deletion: 5
} as const;

/** Annotation kinds never render as a row — they mutate a primary message
 *  (reactions, edits, deletes) and are folded into its view model. */
export const ANNOTATION_KINDS = new Set<number>([
	ChatKinds.Reaction,
	ChatKinds.Edit,
	ChatKinds.Deletion
]);

export function isAnnotationKind(kind: number): boolean {
	return ANNOTATION_KINDS.has(kind);
}

export function isSystemKind(kind: number): boolean {
	return kind === SYSTEM_MESSAGE_KIND;
}
