// Dialog ID constants
export const DIALOG_IDS = {
	LOGIN: 'login'
} as const;

// Reactive dialog state object using Svelte 5 $state
export const dialogState = $state<{ dialogId: string | null }>({
	dialogId: null
});
