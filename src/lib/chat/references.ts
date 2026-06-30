/**
 * Kind reference parsing, send-side tag building, and the shared annotation
 * index. See `src/lib/chat/README.md`.
 *
 * Parsers are pure functions of `(kind, content, tags)` — they do not depend on
 * `StoredChatMessage`. The annotation index is consumed by the chat shell (for
 * the inline view-model fold) and by search (for its own scoping); rich
 * renderers call the parsers directly to self-resolve their context.
 */
import { normalizePubKey } from '$lib/utils';
import { ChatKinds } from '$lib/chat/kinds';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

// ---------------------------------------------------------------------------
// Reference + target types
// ---------------------------------------------------------------------------

export interface ChatMessageReplyTarget {
	id: string;
	pubkey: string;
	kind: number;
	content: string;
	tags: string[][];
}

/** Common target shape for annotation sends (reaction / edit / delete).
 *  All three carry exactly {id, pubkey, kind}; one type replaces three. */
export interface MessageTarget {
	id: string;
	pubkey: string;
	kind: number;
}

export interface ChatMessageThreadReference {
	rootId: string;
	rootPubkey: string;
	rootKind: number;
	parentId: string;
	parentPubkey: string;
	parentKind: number;
}

export interface ChatMessageReactionReference {
	targetId: string;
	targetPubkey: string;
	targetKind: number;
	reaction: string;
}

export interface ChatMessageEditReference {
	targetId: string;
}

export interface ChatMessageDeleteReference {
	targetId: string;
	targetKind: number;
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function findTag(tags: string[][], name: string): string[] | undefined {
	return tags.find((tag) => tag[0] === name);
}

function isFiniteKind(value: string | undefined): value is string {
	if (!value) return false;
	return Number.isFinite(Number(value));
}

// ---------------------------------------------------------------------------
// Send-side tag builders
// ---------------------------------------------------------------------------

export function createReplyMessageTags(target: ChatMessageReplyTarget): string[][] {
	const rootEventTag = findTag(target.tags, 'E');
	const rootKindTag = findTag(target.tags, 'K');
	const rootPubkeyTag = findTag(target.tags, 'P');

	const rootId = rootEventTag?.[1] ?? target.id;
	const rootPubkey = rootPubkeyTag?.[1] ?? rootEventTag?.[3] ?? target.pubkey;
	const rootKind = rootKindTag?.[1] ?? String(target.kind);

	return [
		['E', rootId, '', rootPubkey],
		['K', rootKind],
		['P', rootPubkey],
		['e', target.id, '', target.pubkey],
		['k', String(target.kind)],
		['p', target.pubkey]
	];
}

export function createReactionMessageTags(target: MessageTarget): string[][] {
	return [
		['e', target.id, '', target.pubkey],
		['p', target.pubkey],
		['k', String(target.kind)]
	];
}

export function createEditMessageTags(target: MessageTarget, tags: string[][] = []): string[][] {
	return [
		['e', target.id, '', target.pubkey],
		['p', target.pubkey],
		['k', String(target.kind)],
		...tags
	];
}

export function createDeleteMessageTags(target: MessageTarget): string[][] {
	return [
		['e', target.id, '', target.pubkey],
		['k', String(target.kind)]
	];
}

// ---------------------------------------------------------------------------
// Inbound reference parsers
// ---------------------------------------------------------------------------

export function getMessageThreadReference(tags: string[][]): ChatMessageThreadReference | null {
	const rootEventTag = findTag(tags, 'E');
	const rootKindTag = findTag(tags, 'K');
	const parentEventTag = findTag(tags, 'e');
	const parentKindTag = findTag(tags, 'k');

	if (!rootEventTag || !rootKindTag || !parentEventTag || !parentKindTag) {
		return null;
	}

	if (!isFiniteKind(rootKindTag[1]) || !isFiniteKind(parentKindTag[1])) {
		return null;
	}

	const rootId = rootEventTag[1];
	const parentId = parentEventTag[1];
	const rootPubkey = findTag(tags, 'P')?.[1] ?? rootEventTag[3] ?? '';
	const parentPubkey = findTag(tags, 'p')?.[1] ?? parentEventTag[3] ?? '';

	if (!rootId || !parentId || !rootPubkey || !parentPubkey) {
		return null;
	}

	return {
		rootId,
		rootPubkey,
		rootKind: Number(rootKindTag[1]),
		parentId,
		parentPubkey,
		parentKind: Number(parentKindTag[1])
	};
}

export function getMessageReactionReference(
	kind: number,
	content: string,
	tags: string[][]
): ChatMessageReactionReference | null {
	if (kind !== ChatKinds.Reaction) {
		return null;
	}

	const eventTag = findTag(tags, 'e');
	const pubkeyTag = findTag(tags, 'p');
	const kindTag = findTag(tags, 'k');
	const reaction = content.trim();

	if (!eventTag?.[1] || !pubkeyTag?.[1] || !kindTag?.[1] || !reaction) {
		return null;
	}

	if (!isFiniteKind(kindTag[1])) {
		return null;
	}

	return {
		targetId: eventTag[1],
		targetPubkey: pubkeyTag[1],
		targetKind: Number(kindTag[1]),
		reaction
	};
}

export function getMessageEditReference(
	kind: number,
	content: string,
	tags: string[][]
): ChatMessageEditReference | null {
	if (kind !== ChatKinds.Edit || !content.trim()) {
		return null;
	}

	const eventTag = findTag(tags, 'e');
	if (!eventTag?.[1]) {
		return null;
	}

	return {
		targetId: eventTag[1]
	};
}

export function getMessageDeleteReference(
	kind: number,
	tags: string[][]
): ChatMessageDeleteReference | null {
	if (kind !== ChatKinds.Deletion) {
		return null;
	}

	const eventTag = findTag(tags, 'e');
	const kindTag = findTag(tags, 'k');
	if (!eventTag?.[1] || !isFiniteKind(kindTag?.[1])) {
		return null;
	}

	return {
		targetId: eventTag[1],
		targetKind: Number(kindTag[1])
	};
}

// ---------------------------------------------------------------------------
// Outbound kind + tag resolution (unified so send stays in sync with parsing)
// ---------------------------------------------------------------------------

export interface OutboundMessageInput {
	content: string;
	tags?: string[][];
	replyTo?: ChatMessageReplyTarget;
	reactionTo?: MessageTarget;
	editTo?: MessageTarget;
	deleteTo?: MessageTarget;
}

export interface OutboundMessageShape {
	kind: number;
	content: string;
	tags: string[][];
}

/** Resolves the outbound kind, content, and tags for a send. Replaces the two
 *  parallel switches (one for tags, one for kind) that previously had to be
 *  kept in sync by hand. */
export function resolveOutboundMessage(input: OutboundMessageInput): OutboundMessageShape {
	const isReaction = Boolean(input.reactionTo);
	const isEdit = Boolean(input.editTo);
	const isDelete = Boolean(input.deleteTo);

	if (isReaction) {
		return {
			kind: ChatKinds.Reaction,
			content: input.content,
			tags: createReactionMessageTags(input.reactionTo!)
		};
	}

	if (isDelete) {
		return {
			kind: ChatKinds.Deletion,
			content: '',
			tags: createDeleteMessageTags(input.deleteTo!)
		};
	}

	if (isEdit) {
		return {
			kind: ChatKinds.Edit,
			content: input.content.trim(),
			tags: createEditMessageTags(input.editTo!, input.tags)
		};
	}

	return {
		kind: input.replyTo ? ChatKinds.ThreadReply : ChatKinds.Text,
		content: input.content.trim(),
		tags: [...(input.replyTo ? createReplyMessageTags(input.replyTo) : []), ...(input.tags ?? [])]
	};
}

// ---------------------------------------------------------------------------
// Annotation index — shared by the chat shell (inline fold) and search
// ---------------------------------------------------------------------------

export interface ReactionIndexEntry {
	emoji: string;
	authors: Set<string>;
}

export interface AnnotationIndex {
	byEventId: Map<string, StoredChatMessage>;
	/** targetId -> (emoji -> entry) */
	reactionMap: Map<string, Map<string, ReactionIndexEntry>>;
	/** targetId -> latest edit message */
	editMap: Map<string, StoredChatMessage>;
	/** ids of messages whose deletion has been validated */
	deletedIds: Set<string>;
}

/** Builds the reaction/edit/delete index over a group's messages. Both the chat
 *  shell (for the inline view-model fold) and search consume this so the
 *  resolution rules cannot drift between them.
 *
 *  `messages` is iterated three times (reactions, deletes, edits) in creation
 *  order — deletes must be known before edits resolve, so the ordering is
 *  load-bearing. */
export function buildAnnotationIndex(messages: StoredChatMessage[]): AnnotationIndex {
	const byEventId = new Map(messages.map((message) => [message.id, message]));
	const reactionMap = new Map<string, Map<string, ReactionIndexEntry>>();
	const editMap = new Map<string, StoredChatMessage>();
	const deletedIds = new Set<string>();

	for (const message of messages) {
		const reference = getMessageReactionReference(message.kind, message.content, message.tags);
		if (!reference) continue;

		const byEmoji = reactionMap.get(reference.targetId) ?? new Map<string, ReactionIndexEntry>();
		const entry = byEmoji.get(reference.reaction) ?? {
			emoji: reference.reaction,
			authors: new Set<string>()
		};

		entry.authors.add(normalizePubKey(message.sender));
		byEmoji.set(reference.reaction, entry);
		reactionMap.set(reference.targetId, byEmoji);
	}

	for (const message of messages) {
		const reference = getMessageDeleteReference(message.kind, message.tags);
		if (!reference) continue;

		const original = byEventId.get(reference.targetId);
		if (!original) continue;
		if (reference.targetKind !== original.kind) continue;
		if (normalizePubKey(original.sender) !== normalizePubKey(message.sender)) continue;

		deletedIds.add(reference.targetId);
	}

	for (const message of messages) {
		const reference = getMessageEditReference(message.kind, message.content, message.tags);
		if (!reference) continue;
		if (deletedIds.has(reference.targetId)) continue;

		const original = byEventId.get(reference.targetId);
		if (!original) continue;
		if (normalizePubKey(original.sender) !== normalizePubKey(message.sender)) continue;

		const current = editMap.get(reference.targetId);
		if (!current || message.createdAt > current.createdAt) {
			editMap.set(reference.targetId, message);
		}
	}

	return { byEventId, reactionMap, editMap, deletedIds };
}
