import { parseChatProfileMentions } from '$lib/services/chatMentions';

const MAX_CACHED_PARSED_MESSAGES = 1000;

type ParsedMentionParts = ReturnType<typeof parseChatProfileMentions>;
type ParsedMentionCacheEntry = {
	text: string;
	parts: ParsedMentionParts;
};

const parsedMentionCache = new Map<string, ParsedMentionCacheEntry>();

export function getCachedChatMessageParts(messageId: string, text: string): ParsedMentionParts {
	const cached = parsedMentionCache.get(messageId);
	if (cached?.text === text) return cached.parts;

	const parsed = parseChatProfileMentions(text);
	parsedMentionCache.set(messageId, { text, parts: parsed });
	if (parsedMentionCache.size > MAX_CACHED_PARSED_MESSAGES) {
		const oldestKey = parsedMentionCache.keys().next().value;
		if (oldestKey) parsedMentionCache.delete(oldestKey);
	}

	return parsed;
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
