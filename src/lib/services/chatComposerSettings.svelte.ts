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
 * Whether confirmed reactions render as marker rows in the message timeline
 * (in addition to the chips on the reacted-to message). Default on; users in
 * high-traffic groups can turn it off to keep the timeline messages-only.
 */
const SHOW_REACTION_MARKERS_KEY = 'cordn.showReactionMarkers';

function loadShowReactionMarkers(): boolean {
	if (!browser) return true;
	return localStorage.getItem(SHOW_REACTION_MARKERS_KEY) !== 'false';
}

let showReactionMarkers = $state(loadShowReactionMarkers());

export function getShowReactionMarkers(): boolean {
	return showReactionMarkers;
}

export function setShowReactionMarkers(value: boolean): void {
	showReactionMarkers = value;
	if (browser) localStorage.setItem(SHOW_REACTION_MARKERS_KEY, String(value));
}

/**
 * Whether long messages and embedded nostr events render clamped behind a
 * "Show more" toggle (the inline-body boundedness contract). Default on;
 * turning it off renders everything at full height.
 */
const COLLAPSE_LONG_MESSAGES_KEY = 'cordn.collapseLongMessages';

function loadCollapseLongMessages(): boolean {
	if (!browser) return true;
	return localStorage.getItem(COLLAPSE_LONG_MESSAGES_KEY) !== 'false';
}

let collapseLongMessages = $state(loadCollapseLongMessages());

export function getCollapseLongMessages(): boolean {
	return collapseLongMessages;
}

export function setCollapseLongMessages(value: boolean): void {
	collapseLongMessages = value;
	if (browser) localStorage.setItem(COLLAPSE_LONG_MESSAGES_KEY, String(value));
}
