import { browser } from '$app/environment';
import { isNativePlatform } from '$lib/services/nativeShims';

/**
 * Pull-to-refresh action for touch scroll containers (chat list).
 *
 * Enabled only where the platform offers no pull-to-refresh of its own: the native
 * Android shell (document overscroll is already disabled there) and installed
 * standalone PWAs (Chrome suppresses browser PTR in standalone display mode). In a
 * normal mobile-browser tab the gesture stays off so the browser's own PTR — which
 * doubles as the emergency full reload — keeps working untouched. No
 * `overscroll-behavior` is set anywhere on web, by design.
 *
 * Attaches a self-contained sticky spinner indicator as the container's first child;
 * the container's overflow clips it while retracted. `onRefresh` returning a promise
 * holds the spinner until it settles (capped). `label()` is re-evaluated during the
 * pull to optionally caption the release action (e.g. "Release to update").
 */

/** Damped pull distance (px) at which releasing triggers the refresh. */
export const PTR_THRESHOLD = 64;
const MAX_PULL = 96; // clamp for indicator travel, post-damping
const DAMPING = 0.5; // finger px → indicator px
/** Wrapper translate that fully retracts the indicator behind the container's clip. */
const HIDDEN_OFFSET = 56;
const REFRESH_TIMEOUT_MS = 10_000;

export interface PullToRefreshOptions {
	onRefresh: () => Promise<void> | void;
	label?: () => string | null;
}

/** Damped indicator travel for a raw downward finger delta (px). */
export function dampPull(deltaPx: number): number {
	return Math.max(0, Math.min(deltaPx * DAMPING, MAX_PULL));
}

/** Spinner rotation (deg) for a given damped pull distance. */
export function pullRotation(pull: number): number {
	return (Math.min(pull, MAX_PULL) / MAX_PULL) * 360;
}

function gestureEnabled(): boolean {
	if (!browser) return false;
	if (isNativePlatform()) return true;
	// Standalone PWA: browser PTR is absent, so the custom gesture fills the gap.
	return window.matchMedia('(display-mode: standalone)').matches;
}

function ensureSpinKeyframes() {
	if (document.getElementById('cordn-ptr-style')) return;
	const style = document.createElement('style');
	style.id = 'cordn-ptr-style';
	style.textContent = '@keyframes cordn-ptr-spin{to{transform:rotate(360deg)}}';
	document.head.append(style);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function pullToRefresh(node: HTMLElement, options: PullToRefreshOptions) {
	if (!gestureEnabled()) return;

	ensureSpinKeyframes();

	const wrapper = document.createElement('div');
	Object.assign(wrapper.style, {
		position: 'sticky',
		top: '0',
		height: '0',
		overflow: 'visible',
		zIndex: '10',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		pointerEvents: 'none',
		transition: 'transform 180ms cubic-bezier(0.2, 0.6, 0.3, 1)',
		transform: `translateY(-${HIDDEN_OFFSET}px)`
	});
	const spinner = document.createElement('div');
	Object.assign(spinner.style, {
		width: '28px',
		height: '28px',
		boxSizing: 'border-box',
		borderRadius: '9999px',
		border: '2px solid var(--border)',
		borderTopColor: 'var(--muted-foreground)'
	});
	const label = document.createElement('span');
	Object.assign(label.style, {
		marginTop: '6px',
		fontSize: '11px',
		lineHeight: '1.4',
		fontWeight: '500',
		whiteSpace: 'nowrap',
		color: 'var(--muted-foreground)'
	});
	wrapper.append(spinner, label);
	node.prepend(wrapper);

	let state: 'idle' | 'pulling' | 'refreshing' = 'idle';
	let tracking = false;
	let pull = 0;
	let startX = 0;
	let startY = 0;

	function renderPull() {
		const ratio = Math.min(pull / PTR_THRESHOLD, 1);
		wrapper.style.transform = `translateY(${(pull - HIDDEN_OFFSET).toFixed(1)}px)`;
		spinner.style.transform = `rotate(${pullRotation(pull).toFixed(0)}deg) scale(${(0.7 + 0.3 * ratio).toFixed(2)})`;
		spinner.style.opacity = (0.45 + 0.55 * ratio).toFixed(2);
		spinner.style.borderTopColor = pull >= PTR_THRESHOLD ? 'var(--primary)' : '';
		label.textContent = options.label?.() ?? '';
	}

	function collapse() {
		state = 'idle';
		pull = 0;
		wrapper.style.transition = '';
		wrapper.style.transform = `translateY(-${HIDDEN_OFFSET}px)`;
		spinner.style.transform = '';
		spinner.style.opacity = '';
		spinner.style.borderTopColor = '';
		label.textContent = '';
	}

	async function runRefresh() {
		state = 'refreshing';
		wrapper.style.transition = '';
		wrapper.style.transform = 'translateY(8px)';
		spinner.style.transform = '';
		spinner.style.opacity = '1';
		spinner.style.borderTopColor = 'var(--muted-foreground)';
		spinner.style.animation = 'cordn-ptr-spin 0.8s linear infinite';
		label.textContent = '';
		try {
			await Promise.race([Promise.resolve(options.onRefresh()), sleep(REFRESH_TIMEOUT_MS)]);
		} finally {
			spinner.style.animation = '';
			collapse();
		}
	}

	function onTouchStart(event: TouchEvent) {
		if (state !== 'idle' || event.touches.length !== 1 || node.scrollTop > 0) return;
		tracking = true;
		startX = event.touches[0].clientX;
		startY = event.touches[0].clientY;
	}

	function onTouchMove(event: TouchEvent) {
		if (!tracking || state === 'refreshing') return;
		if (event.touches.length !== 1) {
			if (state === 'pulling') collapse();
			tracking = false;
			return;
		}
		const dx = event.touches[0].clientX - startX;
		const dy = event.touches[0].clientY - startY;
		if (state === 'idle') {
			if (node.scrollTop > 0) {
				tracking = false; // content scrolled — no longer at the top
				return;
			}
			// Engage only on a clear downward pull; horizontal swipes pass through.
			if (dy <= 0 || Math.abs(dx) > dy) return;
			state = 'pulling';
			wrapper.style.transition = 'none';
		}
		event.preventDefault();
		pull = dampPull(dy);
		renderPull();
	}

	function onTouchEnd() {
		if (state === 'pulling' && pull >= PTR_THRESHOLD) void runRefresh();
		else if (state === 'pulling') collapse();
		tracking = false;
	}

	function onTouchCancel() {
		if (state === 'pulling') collapse();
		tracking = false;
	}

	node.addEventListener('touchstart', onTouchStart, { passive: true });
	node.addEventListener('touchmove', onTouchMove, { passive: false });
	node.addEventListener('touchend', onTouchEnd, { passive: true });
	node.addEventListener('touchcancel', onTouchCancel, { passive: true });

	return {
		update(next: PullToRefreshOptions) {
			options = next;
		},
		destroy() {
			node.removeEventListener('touchstart', onTouchStart);
			node.removeEventListener('touchmove', onTouchMove);
			node.removeEventListener('touchend', onTouchEnd);
			node.removeEventListener('touchcancel', onTouchCancel);
			wrapper.remove();
		}
	};
}
