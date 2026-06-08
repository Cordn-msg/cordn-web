import {
	getChatGroupDisplayTitle,
	type ChatGroupProfileHints
} from '$lib/components/chat/chatGroupDisplay';
import {
	getMessageDeleteReference,
	getMessageEditReference,
	getMessageReactionReference,
	type StoredChatMessage
} from '$lib/services/chatGroupMessages.svelte';
import { listChatGroupMembers, listChatGroups } from '$lib/services/chatGroups.svelte';

export interface ChatMessageSearchResult {
	groupId: string;
	groupTitle: string;
	messageKey: string;
	createdAt: number;
	sender: string;
	snippet: string;
}

export interface SearchChatMessagesOptions {
	limit?: number;
	activePubkey?: string;
	profileHints?: ChatGroupProfileHints;
}

const DEFAULT_RESULT_LIMIT = 50;
const SNIPPET_RADIUS = 56;

export function searchChatMessages(
	query: string | string[],
	{ limit = DEFAULT_RESULT_LIMIT, activePubkey, profileHints }: SearchChatMessagesOptions = {}
): ChatMessageSearchResult[] {
	const queries = Array.isArray(query) ? query : [query];
	const normalizedQueries = [
		...new Set(
			queries
				.map((q) => q.trim())
				.map((q) => normalizeSearchText(q))
				.filter((q) => q.length >= 2)
		)
	];
	if (normalizedQueries.length === 0) return [];

	function findMatchIndex(content: string): { index: number; queryLen: number } | null {
		for (const nq of normalizedQueries) {
			const idx = content.indexOf(nq);
			if (idx !== -1) return { index: idx, queryLen: nq.length };
		}
		return null;
	}

	const results: ChatMessageSearchResult[] = [];

	for (const group of listChatGroups()) {
		const searchableMessages = getSearchableMessages(group.messages);
		const messageById = new Map(searchableMessages.map((message) => [message.id, message]));
		const groupTitle = getChatGroupDisplayTitle({
			group,
			activePubkey,
			profileHints,
			memberPubkeys: listChatGroupMembers(group.id).map((member) => member.stablePubkey)
		});

		for (const message of searchableMessages) {
			const reactionReference = getMessageReactionReference(
				message.kind,
				message.content,
				message.tags
			);
			if (reactionReference) {
				const targetMessage = messageById.get(reactionReference.targetId);
				if (!targetMessage) continue;

				const normalizedReaction = normalizeSearchText(reactionReference.reaction);
				const reactionMatch = findMatchIndex(normalizedReaction);
				if (reactionMatch) {
					results.push({
						groupId: group.id,
						groupTitle,
						messageKey: `${targetMessage.id}:${targetMessage.cursor}`,
						createdAt: message.createdAt,
						sender: message.sender,
						snippet: `Reaction ${reactionReference.reaction} to: ${createSnippet(targetMessage.content, 0, 0)}`
					});
				}

				continue;
			}

			const normalizedContent = normalizeSearchText(message.content);
			const match = findMatchIndex(normalizedContent);
			if (!match) continue;

			results.push({
				groupId: group.id,
				groupTitle,
				messageKey: `${message.id}:${message.cursor}`,
				createdAt: message.createdAt,
				sender: message.sender,
				snippet: createSnippet(message.content, match.index, match.queryLen)
			});
		}
	}

	return sortResults(results).slice(0, limit);
}

function getSearchableMessages(messages: StoredChatMessage[]): StoredChatMessage[] {
	const byId = new Map(messages.map((message) => [message.id, message]));
	const deletedMessageIds = new Set<string>();
	const editMap = new Map<string, StoredChatMessage>();

	for (const message of messages) {
		const deleteReference = getMessageDeleteReference(message.kind, message.tags);
		if (!deleteReference) continue;

		const original = byId.get(deleteReference.targetId);
		if (!original) continue;
		if (deleteReference.targetKind !== original.kind) continue;
		if (message.sender !== original.sender) continue;

		deletedMessageIds.add(deleteReference.targetId);
	}

	for (const message of messages) {
		const editReference = getMessageEditReference(message.kind, message.content, message.tags);
		if (!editReference) continue;
		if (deletedMessageIds.has(editReference.targetId)) continue;

		const original = byId.get(editReference.targetId);
		if (!original) continue;
		if (message.sender !== original.sender) continue;

		const current = editMap.get(editReference.targetId);
		if (!current || message.createdAt > current.createdAt) {
			editMap.set(editReference.targetId, message);
		}
	}

	return messages
		.filter((message) => message.kind !== 5 && message.kind !== 1010)
		.filter((message) => !deletedMessageIds.has(message.id))
		.map((message) => editMap.get(message.id) ?? message);
}

function normalizeSearchText(value: string): string {
	return value.toLocaleLowerCase();
}

function createSnippet(content: string, matchIndex: number, queryLength: number): string {
	const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
	const end = Math.min(content.length, matchIndex + queryLength + SNIPPET_RADIUS);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < content.length ? '…' : '';

	return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function sortResults(results: ChatMessageSearchResult[]): ChatMessageSearchResult[] {
	return [...results].sort(
		(a, b) => b.createdAt - a.createdAt || b.messageKey.localeCompare(a.messageKey)
	);
}
