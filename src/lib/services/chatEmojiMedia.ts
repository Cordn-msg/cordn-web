import { emojiSourcesForContent } from '$lib/services/chatEmojiPacks.svelte';
import type { EmojiMediaFailure } from '$lib/services/chatMediaStorage.svelte';

/**
 * The `emoji-media` tags a message's shortcodes earn, and the emoji that could
 * not be carried as pictures. The media module is imported lazily so a message
 * without custom emoji never pays for the crypto graph (or pulls it into the
 * outbox's unit tests).
 *
 * A failed emoji is NOT dropped silently by the caller: sending text without the
 * picture makes the message a different thing from what the composer showed.
 */
export async function emojiMediaTagsForContent(
	groupId: string,
	content: string
): Promise<{ tags: string[][]; mediaKeyBase64?: string; failed: EmojiMediaFailure[] }> {
	const sources = emojiSourcesForContent(content);
	if (sources.length === 0) return { tags: [], failed: [] };
	try {
		const media = await import('./chatMediaStorage.svelte');
		return await media.prepareEmojiMediaTags(groupId, sources);
	} catch (error) {
		console.warn('Could not prepare custom emoji:', error);
		// The preparation itself broke (not one picture): still say so rather than
		// pretending the message carried its emoji.
		return {
			tags: [],
			failed: sources.map((source) => ({
				name: source.name,
				reason: 'the picture could not be prepared'
			}))
		};
	}
}

/** One line a person can read, naming the emoji and why they did not travel. */
export function describeEmojiFailures(failed: EmojiMediaFailure[]): string {
	const names = failed.map((failure) => `:${failure.name}:`).join(', ');
	return `Couldn't include ${names} — ${failed[0].reason}.`;
}
