/**
 * What this device's own evidence says about a message it could not open.
 *
 * - `foreign-keys`: another member's message opened at this device's current
 *   epoch (the line cursor is cleared whenever the epoch is replaced), so at
 *   least one other member is on the same line; the unopenable payloads were
 *   sealed under keys this line does not use.
 * - `behind`: no such proof. This device may have missed a group change, and
 *   the outbound gate already holds sends.
 * - `poisoned`: the inner MLS state failed, not the outer seal — a different
 *   (existing) recovery path owns it.
 */
export type ChatGroupUnopenedVerdict = 'poisoned' | 'foreign-keys' | 'behind' | 'catch-up';

/**
 * The cursor the UI should name for "something here would not open". The
 * durable frontier is earliest; a drop-recovery horizon is next; `staleMark`
 * is the fallback that survives document adoption clearing the frontier (the
 * incident had `staleMark.cursor` 338 but no `firstUnopenedCursor` and no sync
 * issues, so neither banner rendered). No evidence means no banner.
 */
export function chatGroupUnopenedCursor(input: {
	firstUnopenedCursor?: number;
	dropHorizon?: number;
	staleMarkCursor?: number;
}): number | undefined {
	return input.firstUnopenedCursor ?? input.dropHorizon ?? input.staleMarkCursor;
}

export function classifyChatGroupUnopened(input: {
	poisoned: boolean;
	/** Any UI evidence cursor, including old drop issues. */
	firstUnopenedCursor?: number;
	/** The durable behind frontier, cleared by document adoption. */
	durableFrontier?: number;
	/** Cursor of the adopted document that made the MLS state current. */
	adoptedCursor?: number;
	/** Fresh stale/sibling evidence earned after adoption. */
	stateBehind?: boolean;
	lineCursor?: number;
}): ChatGroupUnopenedVerdict | undefined {
	if (input.poisoned) return 'poisoned';
	if (input.firstUnopenedCursor === undefined) return undefined;
	if (
		input.durableFrontier === undefined &&
		input.stateBehind !== true &&
		input.adoptedCursor !== undefined &&
		input.firstUnopenedCursor <= input.adoptedCursor
	)
		return 'catch-up';
	return input.lineCursor !== undefined ? 'foreign-keys' : 'behind';
}

/**
 * Line evidence for records written before `lineCursor` existed: the newest
 * inbound message from another member after the current epoch began, within
 * the loaded window. Best-effort by design — a window without such a message
 * yields no evidence rather than a guess.
 */
export function deriveLineCursor(input: {
	epochStartCursor: number | undefined;
	ownerPubkey: string | undefined;
	messages: ReadonlyArray<{ cursor: number; direction: string; sender: string }>;
}): number | undefined {
	if (input.epochStartCursor === undefined || input.ownerPubkey === undefined) return undefined;
	const owner = input.ownerPubkey.toLowerCase();
	let line: number | undefined;
	for (const message of input.messages) {
		if (message.direction !== 'inbound' || !message.sender) continue;
		if (message.sender.toLowerCase() === owner) continue;
		if (message.cursor <= input.epochStartCursor) continue;
		if (line === undefined || message.cursor > line) line = message.cursor;
	}
	return line;
}
