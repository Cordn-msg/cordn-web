/**
 * Voice-note playback singleton: tracks the one note currently playing so
 * starting another pauses it (WhatsApp/Telegram behavior — never two voices at
 * once). Module-level `$state` in a `.svelte.ts` is the standard Svelte 5
 * shared-singleton pattern; players read `activeId` reactively and pause
 * themselves when it moves off their id.
 */
let activeId = $state<string | null>(null);

export const voicePlayback = {
	get activeId() {
		return activeId;
	},
	/** Claim playback; any other player whose id differs pauses itself. */
	play(id: string) {
		activeId = id;
	},
	/** Release the claim (paused/ended) — only clears if still ours. */
	stop(id: string) {
		if (activeId === id) activeId = null;
	}
};
