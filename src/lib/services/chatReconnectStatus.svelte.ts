/**
 * Aggregate "Updating chats…" banner state.
 *
 * This is a single global banner shown while a chat resume is in progress.
 * Per-coordinator reachability (the sidebar dot, the coordinator detail page)
 * is observed separately in `coordinatorHealth.svelte.ts` and must not be
 * inferred from this banner.
 */
export const chatReconnectStatusStore = $state<{ active: boolean; message: string }>({
	active: false,
	message: ''
});

export function setChatReconnectStatus(message: string) {
	chatReconnectStatusStore.active = true;
	chatReconnectStatusStore.message = message;
}

export function clearChatReconnectStatus() {
	chatReconnectStatusStore.active = false;
	chatReconnectStatusStore.message = '';
}

let failTimer: ReturnType<typeof setTimeout> | null = null;

export function failChatReconnectStatus(message: string) {
	if (failTimer) {
		clearTimeout(failTimer);
	}
	chatReconnectStatusStore.active = true;
	chatReconnectStatusStore.message = message;
	failTimer = setTimeout(() => {
		failTimer = null;
		clearChatReconnectStatus();
	}, 4000);
}
