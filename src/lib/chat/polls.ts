/**
 * NIP-88-style polls adapted to cordn: NIP semantics carried as event envelopes
 * without signatures, sealed as ordinary MLS group messages. See
 * `src/lib/chat/README.md` — poll votes are a kind-specific sparse aggregate:
 * the poll's renderers self-`query` them; the chat shell never folds them.
 *
 * Kind 1068 (poll): `content` = question; `option` tags = (option, id, label);
 * `polltype` = "singlechoice" | "multiplechoice" (absent = singlechoice);
 * `endsAt` = unix-seconds deadline (absent = never closes). NIP-88 `relay` tags
 * are dropped — cordn routes through the group's coordinator, there are no
 * public relays. Unknown extension tags are ignored, known tag shapes stay
 * strict.
 *
 * Kind 1018 (response): `e` tag → poll, `response` tags = selected option ids.
 * A response is a complete-selection replacement, never a delta: exactly one id
 * for singlechoice, 1..N unique ids for multiplechoice. Empty is not an unvote.
 * `content` ("Voted: …") and an NIP-31 `alt` tag are readable fallbacks for
 * clients without poll support, which would otherwise render empty bubbles.
 * One vote per account (stable pubkey) — latest (createdAt, cursor) wins, so
 * multi-device responses by the same account collapse to one vote.
 *
 * ponytail limits, revisit when a real need lands:
 * - kind-5 deletions do NOT retract votes (NIP-88 advises poll relays to
 *   ignore deletes for integrity). If retraction ships, fall back to the
 *   author's newest retained response (the marmot rule).
 * - `created_at` is sender-minted, so a malicious client can only distort its
 *   own vote (window + selection checks reject the rest); ties break on the
 *   coordinator cursor, not on wall-clock alone.
 */
import { safeNormalizePubKey } from '$lib/utils';
import { ChatKinds } from '$lib/chat/kinds';
import { isSafeDisplayText, utf8ByteLength } from '$lib/chat/displayText';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_OPTION_ID_BYTES = 64;
export const POLL_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export type PollType = 'singlechoice' | 'multiplechoice';

export interface PollOptionDefinition {
	id: string;
	label: string;
}

export interface PollDefinition {
	question: string;
	options: PollOptionDefinition[];
	pollType: PollType;
	endsAt: number | null;
}

/** Send-side poll intent: labels only — ids are assigned in display order. */
export interface PollDraft {
	question: string;
	optionLabels: string[];
	pollType: PollType;
	endsAt: number | null;
}

export interface PollResponseReference {
	targetId: string;
	optionIds: string[];
}

export interface PollOptionResult {
	id: string;
	label: string;
	votes: number;
}

/** One voter's effective (latest valid) response. */
export interface PollVote {
	voter: string;
	optionIds: string[];
	/** Effective response time, unix milliseconds (StoredChatMessage.createdAt
	 *  units — the coordinator `at`, NOT the event's `created_at`). */
	votedAt: number;
}

export interface PollTally {
	definition: PollDefinition;
	options: PollOptionResult[];
	participants: number;
	/** The active account's effective selection (empty when it hasn't voted). */
	selection: string[];
	/** All effective votes, ordered by (votedAt, voter). */
	votes: PollVote[];
	open: boolean;
}

// ---------------------------------------------------------------------------
// Validation (send-side drafts + shared text hygiene)
// ---------------------------------------------------------------------------

function isValidOptionId(value: string): boolean {
	return (
		value.length > 0 &&
		utf8ByteLength(value) <= POLL_MAX_OPTION_ID_BYTES &&
		[...value].every((char) => /[a-zA-Z0-9]/.test(char))
	);
}

/** Returns a human-readable error for an invalid draft, or null when sendable. */
export function validatePollDraft(draft: PollDraft, nowSeconds: number): string | null {
	if (!isSafeDisplayText(draft.question)) {
		return 'Question is required (no control characters)';
	}
	if (
		draft.optionLabels.length < POLL_MIN_OPTIONS ||
		draft.optionLabels.length > POLL_MAX_OPTIONS
	) {
		return `Polls need between ${POLL_MIN_OPTIONS} and ${POLL_MAX_OPTIONS} options`;
	}
	for (const label of draft.optionLabels) {
		if (!isSafeDisplayText(label)) {
			return 'Options cannot be empty (no control characters)';
		}
	}
	if (draft.endsAt !== null) {
		const lifetime = draft.endsAt - nowSeconds;
		if (lifetime <= 0 || lifetime > POLL_MAX_LIFETIME_SECONDS) {
			return 'End time must be in the future and at most 30 days away';
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Send-side tag builders
// ---------------------------------------------------------------------------

function isValidSelectionShape(optionIds: string[], max: number): boolean {
	if (optionIds.length === 0 || optionIds.length > max) return false;
	const unique = new Set<string>();
	for (const id of optionIds) {
		if (!isValidOptionId(id) || unique.has(id)) return false;
		unique.add(id);
	}
	return true;
}

/** Builds kind-1068 tags from a validated draft. Throws on invalid drafts so a
 *  buggy caller can never mint a poll other clients refuse to render. */
export function createPollMessageTags(
	draft: PollDraft,
	nowSeconds: number = Date.now() / 1000
): string[][] {
	const error = validatePollDraft(draft, nowSeconds);
	if (error) throw new Error(error);
	const tags = draft.optionLabels.map((label, index) => ['option', String(index), label]);
	tags.push(['polltype', draft.pollType]);
	if (draft.endsAt !== null) tags.push(['endsAt', String(Math.trunc(draft.endsAt))]);
	// NIP-31 plaintext summary for clients that cannot render kind 1068.
	tags.push(['alt', `Poll: ${draft.question}`]);
	return tags;
}

/** Builds kind-1018 tags: house `e`/`p`/`k` target triple (same shape as
 *  reaction tags) plus one `response` tag per selected option id. */
export function createPollResponseTags(
	target: { id: string; pubkey: string; kind: number },
	optionIds: string[]
): string[][] {
	if (!isValidSelectionShape(optionIds, POLL_MAX_OPTIONS)) {
		throw new Error('Invalid poll selection');
	}
	return [
		['e', target.id, '', target.pubkey],
		['p', target.pubkey],
		['k', String(target.kind)],
		...optionIds.map((id) => ['response', id]),
		// NIP-31 plaintext summary for clients that cannot render kind 1018.
		['alt', 'Poll vote']
	];
}

/** Human-readable vote summary for the kind-1018 `content`: clients without
 *  poll support render it as the bubble text (they ignore the response tags).
 *  Falls back to a bare "Voted" when the definition or ids are unknown. */
export function describePollVote(definition: PollDefinition | null, optionIds: string[]): string {
	const labels = optionIds
		.map((id) => definition?.options.find((option) => option.id === id)?.label)
		.filter((label): label is string => Boolean(label));
	return labels.length > 0 ? `Voted: ${labels.join(', ')}` : 'Voted';
}

// ---------------------------------------------------------------------------
// Inbound parsers (strict on known shapes, tolerant of unknown extension tags)
// ---------------------------------------------------------------------------

function findTag(tags: string[][], name: string): string[] | undefined {
	return tags.find((tag) => tag[0] === name);
}

export function getMessagePollDefinition(
	kind: number,
	content: string,
	tags: string[][]
): PollDefinition | null {
	if (kind !== ChatKinds.Poll) return null;

	const options: PollOptionDefinition[] = [];
	let pollType: PollType | null = null;
	let endsAt: number | null = null;

	for (const tag of tags) {
		if (tag[0] === 'option') {
			if (tag.length !== 3 || !isValidOptionId(tag[1]) || !isSafeDisplayText(tag[2])) {
				return null;
			}
			options.push({ id: tag[1], label: tag[2] });
		} else if (tag[0] === 'polltype') {
			if (tag.length !== 2 || pollType !== null) return null;
			if (tag[1] !== 'singlechoice' && tag[1] !== 'multiplechoice') return null;
			pollType = tag[1];
		} else if (tag[0] === 'endsAt') {
			if (tag.length !== 2 || endsAt !== null) return null;
			const parsed = Number(tag[1]);
			if (!Number.isInteger(parsed) || parsed <= 0) return null;
			endsAt = parsed;
		}
		// Unknown extension tags (including NIP-88 `relay` hints) are ignored.
	}

	if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) return null;
	if (new Set(options.map((option) => option.id)).size !== options.length) return null;
	if (!isSafeDisplayText(content)) return null;

	return {
		question: content,
		options,
		pollType: pollType ?? 'singlechoice',
		endsAt
	};
}

export function getMessagePollResponseReference(
	kind: number,
	tags: string[][]
): PollResponseReference | null {
	if (kind !== ChatKinds.PollResponse) return null;

	const eventTag = findTag(tags, 'e');
	if (!eventTag?.[1]) return null;

	const optionIds = tags.filter((tag) => tag[0] === 'response').map((tag) => tag[1]);
	if (!isValidSelectionShape(optionIds, POLL_MAX_OPTIONS)) return null;

	return { targetId: eventTag[1], optionIds };
}

// ---------------------------------------------------------------------------
// Tally — the poll's sparse aggregate, computed by its renderers
// ---------------------------------------------------------------------------

function isValidSelection(definition: PollDefinition, optionIds: string[]): boolean {
	if (definition.pollType === 'singlechoice' && optionIds.length !== 1) return false;
	const known = new Set(definition.options.map((option) => option.id));
	return optionIds.every((id) => known.has(id));
}

function sameIds(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Projects a poll's effective votes from a group's messages: window- and
 * selection-valid responses only, one vote per account (latest (createdAt,
 * cursor) wins). Returns null when the poll row is absent or unparseable
 * (callers render an explicit unsupported-poll state).
 */
export function buildPollTally(
	messages: StoredChatMessage[],
	pollId: string,
	myPubkey: string,
	nowSeconds: number = Date.now() / 1000
): PollTally | null {
	const pollMessage = messages.find((message) => message.id === pollId);
	if (!pollMessage) return null;
	const definition = getMessagePollDefinition(
		pollMessage.kind,
		pollMessage.content,
		pollMessage.tags
	);
	if (!definition) return null;

	const effective = new Map<string, StoredChatMessage>();
	for (const message of messages) {
		const reference = getMessagePollResponseReference(message.kind, message.tags);
		if (!reference || reference.targetId !== pollId) continue;
		// Valid only "within the poll limits": never before the poll, never after
		// the deadline. Stored `createdAt` is unix MILLISECONDS (coordinator `at`)
		// while `endsAt` is NIP-88 unix SECONDS — convert at this compare.
		if (message.createdAt < pollMessage.createdAt) continue;
		const votedAtSeconds = Math.floor(message.createdAt / 1000);
		if (definition.endsAt !== null && votedAtSeconds > definition.endsAt) continue;
		if (!isValidSelection(definition, reference.optionIds)) continue;

		const voter = safeNormalizePubKey(message.sender);
		if (!voter) continue;

		const current = effective.get(voter);
		if (
			!current ||
			message.createdAt > current.createdAt ||
			(message.createdAt === current.createdAt && message.cursor > current.cursor)
		) {
			effective.set(voter, message);
		}
	}

	const votes: PollVote[] = [];
	for (const [voter, message] of effective) {
		const reference = getMessagePollResponseReference(message.kind, message.tags);
		if (!reference) continue; // already shape-validated above
		votes.push({ voter, optionIds: reference.optionIds, votedAt: message.createdAt });
	}
	votes.sort((a, b) => a.votedAt - b.votedAt || a.voter.localeCompare(b.voter));

	const me = myPubkey ? effective.get(safeNormalizePubKey(myPubkey) ?? '') : undefined;
	const myReference = me ? getMessagePollResponseReference(me.kind, me.tags) : null;

	return {
		definition,
		options: definition.options.map((option) => ({
			id: option.id,
			label: option.label,
			votes: votes.filter((vote) => vote.optionIds.includes(option.id)).length
		})),
		participants: votes.length,
		selection: myReference?.optionIds ?? [],
		votes,
		open: definition.endsAt === null || nowSeconds < definition.endsAt
	};
}

export { sameIds as samePollSelection };
