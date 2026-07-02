import type { ChatMessage } from '$lib/components/chat/chat.types';

// Pending outgoing (optimistic) messages live here, keyed by groupId, instead
// of in ChatShell's view-local state. View-local state is the wrong home: it
// either leaks an in-flight "sending" message into every group you open, or
// (if cleared on navigation) vanishes when you leave the group and come back.
// Keying by group keeps each pending message attached to its own group, so it
// survives navigating between groups and ChatShell unmounting, and is removed
// by the send's completion callback wherever you are when it lands.
//
// NOT persisted across page reloads: a refresh kills the in-flight
// sendChatGroupMessage promise, which cannot be resumed. Surviving a refresh
// would need the send INTENT persisted to storage and re-encrypted + resent on
// load — a separate feature (and a plaintext-at-rest tradeoff), not done here.
const MAX_PENDING_PER_GROUP = 20;
const outbox = $state<Record<string, ChatMessage[]>>({});

export function getPendingMessages(groupId: string): ChatMessage[] {
	return outbox[groupId] ?? [];
}

export function addPendingMessage(groupId: string, message: ChatMessage): void {
	const current = outbox[groupId] ?? [];
	outbox[groupId] = [...current, message].slice(-MAX_PENDING_PER_GROUP);
}

export function removePendingMessage(groupId: string, messageId: string): void {
	const current = outbox[groupId];
	if (!current) return;
	outbox[groupId] = current.filter((message) => message.id !== messageId);
}

export function updatePendingMessage(
	groupId: string,
	messageId: string,
	updater: (message: ChatMessage) => ChatMessage
): void {
	const current = outbox[groupId];
	if (!current) return;
	outbox[groupId] = current.map((message) =>
		message.id === messageId ? updater(message) : message
	);
}
