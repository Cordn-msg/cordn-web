import { emojiSourcesForContent } from '$lib/services/chatEmojiPacks.svelte';

/**
 * The `emoji-media` tags a message's shortcodes earn. The media module is
 * imported lazily so a message without custom emoji never pays for the crypto
 * graph (or pulls it into the outbox's unit tests).
 */
export async function emojiMediaTagsForContent(
	groupId: string,
	content: string
): Promise<{ tags: string[][]; mediaKeyBase64?: string }> {
	const sources = emojiSourcesForContent(content);
	if (sources.length === 0) return { tags: [] };
	try {
		const media = await import('./chatMediaStorage.svelte');
		return await media.prepareEmojiMediaTags(groupId, sources);
	} catch (error) {
		// The message is more important than its decoration: it travels as text.
		console.warn('Could not prepare custom emoji:', error);
		return { tags: [] };
	}
}
