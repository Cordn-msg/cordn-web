import type { ChatMessage } from './chat.types';

/**
 * Whether a message row is the visible tail of its author run — where the
 * avatar anchors (Signal-style, bottom-aligned beside the newest message).
 * A run ends at the list end, at the next row being another author's, OR at
 * the next row being a system row: system rows (reaction markers, MLS commit
 * notes) can carry the SAME author as the run, and without breaking the run
 * there they swallow the run's avatar (system rows never show one) — a
 * member's closing reaction to an older message left their whole run without
 * an identity anchor.
 */
export function isRunTail(message: ChatMessage, nextMessage: ChatMessage | undefined): boolean {
	if (message.systemKind) return false;
	return Boolean(nextMessage?.systemKind) || nextMessage?.author !== message.author;
}

/**
 * Whether a message row is followed by another real message from the same
 * author, i.e. its author run continues below. Used for spacing: consecutive
 * same-author bubbles stack tightly, while author changes, system rows and the
 * run tail keep the normal gap.
 */
export function isRunContinuation(
	message: ChatMessage,
	nextMessage: ChatMessage | undefined
): boolean {
	return !message.systemKind && !isRunTail(message, nextMessage);
}
