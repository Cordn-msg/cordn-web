import type { ChatMessage } from '$lib/components/chat/chat.types';

// Pending outgoing messages, keyed by groupId, instead of in ChatShell's
// view-local state. View-local state is the wrong home: it either leaks an
// in-flight "sending" message into every group you open, or (if cleared on
// navigation) vanishes when you leave the group and come back. Keying by group
// keeps each pending message attached to its own group, so it survives
// navigating between groups and ChatShell unmounting.
//
// This is the UI projection only. The durable truth is the outbox store in
// IndexedDB (chatOutboxQueue.ts enqueues/drains and hydrates this map on
// load and account change); bubbles here carry `outbox:{seq}` ids that map
// 1:1 to StoredChatOutboxRecord.seq. Media optimistic bubbles (upload-in-flight,
// `optimistic:` ids) are NOT persisted — the file bytes aren't retained.
const MAX_PENDING_PER_GROUP = 100;
const outbox = $state<Record<string, ChatMessage[]>>({});

export function getPendingMessages(groupId: string): ChatMessage[] {
	return outbox[groupId] ?? [];
}

/** Replace the whole projection (hydration / account switch). */
export function replaceAllPending(record: Record<string, ChatMessage[]>): void {
	for (const key of Object.keys(outbox)) {
		delete outbox[key];
	}
	for (const [key, value] of Object.entries(record)) {
		outbox[key] = value;
	}
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

/** Pending outgoing edits, keyed by groupId. They project onto their TARGET
 *  message — the entry IS the optimistic text swap plus the usual delivery
 *  clock (queued/sending/error + tooltip), so an edit behaves exactly like a
 *  queued send instead of vanishing when the post fails. Several queued edits
 *  for one target stay in order and the newest content wins in the fold. */
export interface PendingEdit {
	/** `outbox:${seq}` entry id — retry plumbing (retryOutboxEntry). */
	id: string;
	targetId: string;
	content: string;
	deliveryState: ChatMessage['deliveryState'];
	deliveryDetail?: string;
	/** Held back only by its custom emoji: the target offers the same
	 *  send-without-emoji / discard exits a pending bubble does. */
	emojiBlocked?: boolean;
}

const pendingEdits = $state<Record<string, PendingEdit[]>>({});

export function getPendingEdits(groupId: string): PendingEdit[] {
	return pendingEdits[groupId] ?? [];
}

/** Replace the whole edit projection (hydration / account switch). */
export function replaceAllPendingEdits(record: Record<string, PendingEdit[]>): void {
	for (const key of Object.keys(pendingEdits)) {
		delete pendingEdits[key];
	}
	for (const [key, value] of Object.entries(record)) {
		pendingEdits[key] = value;
	}
}

export function addPendingEdit(groupId: string, edit: PendingEdit): void {
	const current = pendingEdits[groupId] ?? [];
	pendingEdits[groupId] = [...current, edit].slice(-MAX_PENDING_PER_GROUP);
}

export function removePendingEdit(groupId: string, editId: string): void {
	const current = pendingEdits[groupId];
	if (!current) return;
	pendingEdits[groupId] = current.filter((edit) => edit.id !== editId);
}

export function updatePendingEdit(
	groupId: string,
	editId: string,
	updater: (edit: PendingEdit) => PendingEdit
): void {
	const current = pendingEdits[groupId];
	if (!current) return;
	pendingEdits[groupId] = current.map((edit) => (edit.id === editId ? updater(edit) : edit));
}
