/**
 * Local avatar implementation (no bits-ui): bits-ui's Avatar preloads
 * images with a detached `Image()` whose onload survives component
 * destruction and reads a destroyed derived (svelte-toolbelt DOMContext) —
 * the open leak class bits-ui#2050. (Not the source of the tooltip
 * `derived_inert` warnings — that was bits-ui#2080, patched separately —
 * but the same class, and this avoids it entirely.) Cleanup detaches the
 * handlers so nothing fires after unmount.
 */
import { SvelteSet } from 'svelte/reactivity';

export const AVATAR_STATUS_KEY = 'avatar-loading-status';

/**
 * Pictures this session already painted, keyed by src and shared by every avatar
 * implementation: profile bubbles use `Avatar`, group/list/hover avatars use
 * `AvatarImage`. A remount then paints warm instead of replaying its load fade
 * (or a detached-preload round trip) for a picture the browser already has.
 */
export const loadedAvatarPictures = new SvelteSet<string>();

export type AvatarLoadingStatus = 'loading' | 'loaded' | 'error';

export interface AvatarStatusContext {
	readonly status: AvatarLoadingStatus;
	set: (status: AvatarLoadingStatus) => void;
}
