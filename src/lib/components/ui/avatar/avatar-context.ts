/**
 * Local avatar implementation (no bits-ui): bits-ui's Avatar preloads
 * images with a detached `Image()` whose onload survives component
 * destruction and reads a destroyed derived (svelte-toolbelt DOMContext) —
 * the open leak class bits-ui#2050. (Not the source of the tooltip
 * `derived_inert` warnings — that was bits-ui#2080, patched separately —
 * but the same class, and this avoids it entirely.) Cleanup detaches the
 * handlers so nothing fires after unmount.
 */
export const AVATAR_STATUS_KEY = 'avatar-loading-status';

export type AvatarLoadingStatus = 'loading' | 'loaded' | 'error';

export interface AvatarStatusContext {
	readonly status: AvatarLoadingStatus;
	set: (status: AvatarLoadingStatus) => void;
}
