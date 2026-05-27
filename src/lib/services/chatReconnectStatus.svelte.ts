import { SvelteSet } from 'svelte/reactivity';

type ChatReconnectPhase = 'idle' | 'checking' | 'reconnecting' | 'syncing' | 'error';

export const chatReconnectStatusStore = $state<{
	active: boolean;
	phase: ChatReconnectPhase;
	message: string;
	activeCoordinatorKeys: string[];
}>({
	active: false,
	phase: 'idle',
	message: '',
	activeCoordinatorKeys: []
});

let clearTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingTimer() {
	if (!clearTimer) {
		return;
	}

	clearTimeout(clearTimer);
	clearTimer = null;
}

export function setChatReconnectStatus(input: {
	phase: Exclude<ChatReconnectPhase, 'idle'>;
	message: string;
	activeCoordinatorKeys?: Iterable<string>;
}) {
	clearPendingTimer();
	chatReconnectStatusStore.active = true;
	chatReconnectStatusStore.phase = input.phase;
	chatReconnectStatusStore.message = input.message;
	chatReconnectStatusStore.activeCoordinatorKeys = input.activeCoordinatorKeys
		? [...new SvelteSet(input.activeCoordinatorKeys)]
		: chatReconnectStatusStore.activeCoordinatorKeys;
}

export function clearChatReconnectStatus() {
	clearPendingTimer();
	chatReconnectStatusStore.active = false;
	chatReconnectStatusStore.phase = 'idle';
	chatReconnectStatusStore.message = '';
}

export function failChatReconnectStatus(message: string) {
	clearPendingTimer();
	chatReconnectStatusStore.active = true;
	chatReconnectStatusStore.phase = 'error';
	chatReconnectStatusStore.message = message;
	clearTimer = setTimeout(() => {
		clearTimer = null;
		clearChatReconnectStatus();
	}, 4000);
}

export function getCoordinatorReconnectState(coordinatorKey: string): 'idle' | 'active' {
	return chatReconnectStatusStore.activeCoordinatorKeys.includes(coordinatorKey) &&
		chatReconnectStatusStore.active
		? 'active'
		: 'idle';
}

export function getCoordinatorReconnectTone(
	coordinatorKey: string
): 'healthy' | 'active' | 'error' | 'idle' {
	if (getCoordinatorReconnectState(coordinatorKey) !== 'active') {
		return 'healthy';
	}

	return chatReconnectStatusStore.phase === 'error' ? 'error' : 'active';
}

export function getCoordinatorReconnectLabel(coordinatorKey: string): string {
	const tone = getCoordinatorReconnectTone(coordinatorKey);
	if (tone === 'error') {
		return chatReconnectStatusStore.message || 'Connection issue';
	}

	if (tone === 'active') {
		return chatReconnectStatusStore.message || 'Updating';
	}

	return 'Healthy';
}
