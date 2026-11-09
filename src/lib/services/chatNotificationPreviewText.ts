import { SYSTEM_MESSAGE_KIND } from '$lib/chat/kinds';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
import { samePubKey } from '$lib/utils';

/** The newest inbound, unread, non-system message and how many others ride with it. */
export function selectNotificationPreview(
	messages: StoredChatMessage[],
	ownerPubkey: string,
	readCursor: number
): { last: StoredChatMessage; count: number } | undefined {
	const eligible = messages
		.filter((message) => {
			if (message.kind === SYSTEM_MESSAGE_KIND) return false;
			if (message.cursor <= readCursor) return false;
			if (samePubKey(message.sender, ownerPubkey)) return false;
			return true;
		})
		.sort((a, b) => a.cursor - b.cursor);
	const last = eligible[eligible.length - 1];
	return last ? { last, count: eligible.length } : undefined;
}
