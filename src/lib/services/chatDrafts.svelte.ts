import { SvelteMap } from 'svelte/reactivity';

const drafts = new SvelteMap<string, string>();

export function getChatDraft(groupId: string): string {
	return drafts.get(groupId) ?? '';
}

export function getChatDraftPreview(groupId: string): string {
	const draft = drafts.get(groupId);
	if (!draft) return '';
	const trimmed = draft.trim();
	if (!trimmed) return '';
	return `Draft: ${trimmed}`;
}

export function setChatDraft(groupId: string, text: string): void {
	if (text === '') {
		drafts.delete(groupId);
	} else {
		drafts.set(groupId, text);
	}
}

export function clearChatDraft(groupId: string): void {
	drafts.delete(groupId);
}
