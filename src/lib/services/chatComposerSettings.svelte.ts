import { browser } from '$app/environment';

/**
 * Enter-key behavior preference for the chat composer.
 *
 * 'auto' (default) sends on keyboard devices and inserts a newline on touch
 * devices — the WhatsApp/iMessage/ChatGPT-mobile convention, since Shift+Enter
 * doesn't exist on soft keyboards. 'send' / 'newline' are explicit overrides
 * for users who want one behavior everywhere (Telegram-desktop-style setting).
 */
const ENTER_KEY_MODE_KEY = 'cordn.enterKeyMode';

export type EnterKeyMode = 'auto' | 'send' | 'newline';

function loadEnterKeyMode(): EnterKeyMode {
	if (!browser) return 'auto';
	const stored = localStorage.getItem(ENTER_KEY_MODE_KEY);
	return stored === 'send' || stored === 'newline' ? stored : 'auto';
}

let enterKeyMode = $state<EnterKeyMode>(loadEnterKeyMode());

export function getEnterKeyMode(): EnterKeyMode {
	return enterKeyMode;
}

export function setEnterKeyMode(mode: EnterKeyMode): void {
	enterKeyMode = mode;
	if (browser) localStorage.setItem(ENTER_KEY_MODE_KEY, mode);
}

/**
 * Pure resolution of the effective behavior: explicit overrides win; 'auto'
 * adapts to the device's primary pointer. Separated from `enterKeySends` so
 * the logic is testable without mocking matchMedia.
 */
export function resolveEnterKeySends(mode: EnterKeyMode, touchPrimary: boolean): boolean {
	if (mode === 'send') return true;
	if (mode === 'newline') return false;
	return !touchPrimary;
}

/**
 * Touch-primary = soft keyboard is the only realistic input, so Shift+Enter is
 * unavailable. `not (any-pointer: fine)` keeps tablets with a Bluetooth
 * keyboard/mouse on Enter-to-send, where Shift+Enter exists.
 */
function isTouchPrimary(): boolean {
	return (
		typeof matchMedia !== 'undefined' &&
		matchMedia('(pointer: coarse) and (not (any-pointer: fine))').matches
	);
}

/** Effective Enter behavior right now. Reads the reactive module state, so
 *  settings changes apply to mounted composers instantly. */
export function enterKeySends(): boolean {
	return resolveEnterKeySends(enterKeyMode, isTouchPrimary());
}

/**
 * A boolean chat-behavior setting persisted to localStorage, default on
 * (only the explicit string "false" turns it off, so old installs keep the
 * default). Module $state → reading the getter in a template/effect is
 * reactive, so toggles apply live without remounts.
 */
function persistedChatBool(key: string) {
	let value = $state(browser ? localStorage.getItem(key) !== 'false' : true);
	return {
		get: () => value,
		set(next: boolean) {
			value = next;
			if (browser) localStorage.setItem(key, String(next));
		}
	};
}

/** Whether confirmed reactions render as marker rows in the message timeline
 *  (in addition to the chips on the reacted-to message). Default on; users in
 *  high-traffic groups can turn it off to keep the timeline messages-only. */
const showReactionMarkersSetting = persistedChatBool('cordn.showReactionMarkers');

/** Whether long messages and embedded nostr events render clamped behind a
 *  "Show more" toggle (the inline-body boundedness contract). Default on. */
const collapseLongMessagesSetting = persistedChatBool('cordn.collapseLongMessages');

/** Whether pasted nostr event links (nevent/naddr/note) render as inline
 *  embed cards that fetch the event from relays. Default on; turned off the
 *  link stays a plain reference with the ⋯ menu (open externally) and no
 *  relay fetch happens. */
const renderNostrEmbedsSetting = persistedChatBool('cordn.renderNostrEmbeds');

export function getShowReactionMarkers(): boolean {
	return showReactionMarkersSetting.get();
}

export function setShowReactionMarkers(value: boolean): void {
	showReactionMarkersSetting.set(value);
}

export function getCollapseLongMessages(): boolean {
	return collapseLongMessagesSetting.get();
}

export function setCollapseLongMessages(value: boolean): void {
	collapseLongMessagesSetting.set(value);
}

export function getRenderNostrEmbeds(): boolean {
	return renderNostrEmbedsSetting.get();
}

export function setRenderNostrEmbeds(value: boolean): void {
	renderNostrEmbedsSetting.set(value);
}
