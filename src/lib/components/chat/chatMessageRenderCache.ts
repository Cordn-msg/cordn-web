import { parseChatProfileMentions } from '$lib/services/chatMentions';
import { mayContainMarkdown, parseMarkdown, type MarkdownBlock } from '$lib/markdown/parseMarkdown';
import { extractChatInvites, tidyChatBodyText, type ChatInvite } from '$lib/chat/chatInvites';
import type { ChatMessage } from './chat.types';

const MAX_CACHED_PARSED_MESSAGES = 1000;

type ParsedMentionParts = ReturnType<typeof parseChatProfileMentions>;
type ParsedMentionCacheEntry = {
	text: string;
	parts: ParsedMentionParts;
	/** Lazily derived once per text: invite cards + the body parts left after
	 * the invite link texts leave the message (a card stands in for each). */
	invites?: ChatInvite[];
	bodyParts?: ParsedMentionParts;
};

const parsedMentionCache = new Map<string, ParsedMentionCacheEntry>();

function getCachedChatMessagePartsEntry(messageId: string, text: string): ParsedMentionCacheEntry {
	const parsed = parseChatProfileMentions(text);
	const entry: ParsedMentionCacheEntry = { text, parts: parsed };
	parsedMentionCache.set(messageId, entry);
	if (parsedMentionCache.size > MAX_CACHED_PARSED_MESSAGES) {
		const oldestKey = parsedMentionCache.keys().next().value;
		if (oldestKey) parsedMentionCache.delete(oldestKey);
	}
	return entry;
}

export function getCachedChatMessageParts(messageId: string, text: string): ParsedMentionParts {
	const cached = parsedMentionCache.get(messageId);
	if (cached?.text === text) return cached.parts;

	return getCachedChatMessagePartsEntry(messageId, text).parts;
}

export interface ChatMessageInvites {
	invites: ChatInvite[];
	/** Parts for the bubble body: the original parts when there are no invites,
	 * otherwise re-parsed from the text with invite links taken out. */
	bodyParts: ParsedMentionParts;
}

/** Invite cards for a message plus the body parts left once the invite link
 * texts leave it. Same cache entry (and discipline) as the mention parts, so
 * the plain-text pipeline parses a message at most twice ever (raw + tidied)
 * and only when it actually carries an invite. */
export function getCachedChatMessageInvites(messageId: string, text: string): ChatMessageInvites {
	let entry = parsedMentionCache.get(messageId);
	if (entry?.text !== text) entry = getCachedChatMessagePartsEntry(messageId, text);
	if (entry.invites !== undefined && entry.bodyParts !== undefined) {
		return { invites: entry.invites, bodyParts: entry.bodyParts };
	}

	// Cheap gate before any URL work (Staircase's rule): every invite href says
	// cordn somewhere — a known host, a bare cordn1 code, or our own origin.
	const saysCordn =
		text.includes('cordn') ||
		(typeof window !== 'undefined' ? text.includes(window.location.hostname) : false);
	const extracted = saysCordn ? extractChatInvites(entry.parts) : { invites: [], linkTexts: [] };
	const bodyParts = extracted.invites.length
		? parseChatProfileMentions(tidyChatBodyText(text, extracted.linkTexts))
		: entry.parts;
	entry.invites = extracted.invites;
	entry.bodyParts = bodyParts;
	return { invites: extracted.invites, bodyParts };
}

type MarkdownCacheEntry = {
	text: string;
	blocks: MarkdownBlock[];
};

const markdownCache = new Map<string, MarkdownCacheEntry>();

/**
 * Markdown block VM for a message, or null when the text has no markdown
 * triggers — the null path is the plain-text fast lane (mention/link
 * pipeline only, exactly today's cost). Same cache discipline as the
 * mention cache: id+text keyed, bounded, FIFO-evicted.
 */
export function getCachedChatMarkdownBlocks(
	messageId: string,
	text: string
): MarkdownBlock[] | null {
	if (!mayContainMarkdown(text)) return null;

	const cached = markdownCache.get(messageId);
	if (cached?.text === text) return cached.blocks;

	const blocks = parseMarkdown(text);
	markdownCache.set(messageId, { text, blocks });
	if (markdownCache.size > MAX_CACHED_PARSED_MESSAGES) {
		const oldestKey = markdownCache.keys().next().value;
		if (oldestKey) markdownCache.delete(oldestKey);
	}

	return blocks;
}

export function loadCustomChatReactions(): string[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const stored = localStorage.getItem('chat-custom-reactions');
		if (!stored) return [];
		const parsed = JSON.parse(stored);
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === 'string')
			: [];
	} catch {
		return [];
	}
}

export function saveCustomChatReactions(reactions: string[]): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem('chat-custom-reactions', JSON.stringify(reactions));
}

// Calibrated against measured rows: a one-line text message renders at 62px
// (bubble + timestamp row) and each wrapped line adds ~20px. Estimates feed
// scrollToIndex — overshoot clamps a deep focus scroll to the bottom, which is
// exactly how open-at-first-unread used to silently fail.
// ponytail: still coarse buckets (measured rows use their real heights) —
// refine toward per-part math (reply chips, mentions) only if first-pass jumps
// still visibly miss.
export function estimateChatMessageHeight(message: ChatMessage): number {
	if (message.systemKind) return 48;
	if (message.media || message.tags?.some((tag) => tag[0] === 'imeta')) return 264;
	const lines = Math.min(30, Math.max(1, Math.ceil(message.text.length / 32)));
	return 62 + (lines - 1) * 20;
}
