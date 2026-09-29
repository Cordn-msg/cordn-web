<script lang="ts">
	import { tick } from 'svelte';
	import { mediaLightbox, closeMediaLightbox } from '$lib/services/chatMediaLightbox.svelte';
	import { downloadObjectUrl } from '$lib/utils';
	import Download from '@lucide/svelte/icons/download';
	import Home from '@lucide/svelte/icons/home';
	import X from '@lucide/svelte/icons/x';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';

	const current = $derived(mediaLightbox.current);

	const MIN_SCALE = 0.1;
	const MAX_SCALE = 6;
	const DOUBLE_TAP_MS = 300;
	const DOUBLE_TAP_TOLERANCE = 40;
	const DOUBLE_TAP_ZOOM = 2.5;
	const GESTURE_MOVE_TOLERANCE = 10;

	let backdrop: HTMLDivElement | null = $state(null);
	let img: HTMLImageElement | null = $state(null);
	let scale = $state(1);
	let tx = $state(0);
	let ty = $state(0);
	let dragging = $state(false);

	// Gesture bookkeeping: pointers are tracked in a Map so two-finger pinch
	// works alongside single-pointer pan. 1 pointer = pan, 2 = pinch-zoom
	// anchored at the midpoint (which also pans with the fingers).
	const pointers = new Map<number, { x: number; y: number }>();
	let gestureStart: {
		scale: number;
		tx: number;
		ty: number;
		dist: number;
		midX: number;
		midY: number;
	} | null = null;
	let panStart: { x: number; y: number; tx: number; ty: number } | null = null;
	let gestureMoved = false;
	let gestureOnImage = false;
	let gestureStartX = 0;
	let gestureStartY = 0;
	let lastTap: { at: number; x: number; y: number } | null = null;
	let suppressDblclickUntil = 0;

	// Reset transforms and move focus into the dialog whenever a new image opens.
	$effect(() => {
		if (!current) return;
		scale = 1;
		tx = 0;
		ty = 0;
		pointers.clear();
		gestureStart = null;
		panStart = null;
		lastTap = null;
		void tick().then(() => backdrop?.focus());
	});

	function onWindowKeydown(event: KeyboardEvent) {
		if (current && event.key === 'Escape') closeMediaLightbox();
	}

	function clampScale(next: number) {
		return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(next.toFixed(3))));
	}

	/** Pan bounds so the image can't be dragged fully out of view: half the
	 *  zoom overflow per side (0 at scale <= 1 → image recenters). */
	function clampPan(nextTx: number, nextTy: number): [number, number] {
		if (!img || scale <= 1) return [0, 0];
		const limitX = Math.max(0, (img.clientWidth * (scale - 1)) / 2);
		const limitY = Math.max(0, (img.clientHeight * (scale - 1)) / 2);
		return [
			Math.min(limitX, Math.max(-limitX, nextTx)),
			Math.min(limitY, Math.max(-limitY, nextTy))
		];
	}

	/** Translate that keeps the viewport point (ax, ay) fixed while zooming from
	 *  the current scale to `nextScale`. Standard zoom-toward-focus math. */
	function anchoredTranslate(nextScale: number, ax: number, ay: number) {
		const rect = backdrop?.getBoundingClientRect();
		if (!rect) return { tx, ty };
		const rx = ax - (rect.left + rect.width / 2);
		const ry = ay - (rect.top + rect.height / 2);
		const ratio = nextScale / scale;
		return { tx: rx - (rx - tx) * ratio, ty: ry - (ry - ty) * ratio };
	}

	function applyZoom(nextScale: number, ax?: number, ay?: number) {
		const next = clampScale(nextScale);
		scale = next;
		if (ax !== undefined && ay !== undefined) {
			const anchor = anchoredTranslate(next, ax, ay);
			const clamped = clampPan(anchor.tx, anchor.ty);
			tx = clamped[0];
			ty = clamped[1];
		} else {
			const clamped = clampPan(tx, ty);
			tx = clamped[0];
			ty = clamped[1];
		}
	}

	function zoomBy(delta: number) {
		applyZoom(scale + delta);
	}

	function toggleZoomAt(ax: number, ay: number) {
		if (scale > 1.01) reset();
		else applyZoom(DOUBLE_TAP_ZOOM, ax, ay);
	}

	function reset() {
		scale = 1;
		tx = 0;
		ty = 0;
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		applyZoom(scale + (event.deltaY < 0 ? 0.25 : -0.25), event.clientX, event.clientY);
	}

	function pinchValues() {
		const [a, b] = [...pointers.values()];
		return {
			dist: Math.hypot(a.x - b.x, a.y - b.y),
			midX: (a.x + b.x) / 2,
			midY: (a.y + b.y) / 2
		};
	}

	function onPointerDown(event: PointerEvent) {
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		if (pointers.size === 1) {
			// Gesture state belongs to the first finger — a second finger landing
			// must not clear gestureMoved (that let a pinch masquerade as a tap).
			gestureMoved = false;
			gestureOnImage = (event.target as HTMLElement).closest('img') !== null;
			gestureStartX = event.clientX;
			gestureStartY = event.clientY;
			gestureStart = null;
			panStart = { x: event.clientX, y: event.clientY, tx, ty };
		} else if (pointers.size === 2) {
			panStart = null;
			const { dist, midX, midY } = pinchValues();
			gestureStart = { scale, tx, ty, dist, midX, midY };
		}
		dragging = pointers.size > 0;
	}

	function onPointerMove(event: PointerEvent) {
		if (!pointers.has(event.pointerId)) return;
		if (
			Math.hypot(event.clientX - gestureStartX, event.clientY - gestureStartY) >
			GESTURE_MOVE_TOLERANCE
		) {
			gestureMoved = true;
		}
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

		if (pointers.size >= 2 && gestureStart) {
			const { dist, midX, midY } = pinchValues();
			if (gestureStart.dist <= 0) return;
			const next = clampScale(gestureStart.scale * (dist / gestureStart.dist));
			const rect = backdrop?.getBoundingClientRect();
			if (!rect) return;
			// Zoom anchored at the pinch start midpoint, then follow its movement.
			const rx = gestureStart.midX - (rect.left + rect.width / 2);
			const ry = gestureStart.midY - (rect.top + rect.height / 2);
			const ratio = next / gestureStart.scale;
			const nextTx = rx - (rx - gestureStart.tx) * ratio + (midX - gestureStart.midX);
			const nextTy = ry - (ry - gestureStart.ty) * ratio + (midY - gestureStart.midY);
			scale = next;
			const clamped = clampPan(nextTx, nextTy);
			tx = clamped[0];
			ty = clamped[1];
		} else if (pointers.size === 1 && panStart) {
			const clamped = clampPan(
				panStart.tx + (event.clientX - panStart.x),
				panStart.ty + (event.clientY - panStart.y)
			);
			tx = clamped[0];
			ty = clamped[1];
		}
	}

	function onPointerUp(event: PointerEvent) {
		pointers.delete(event.pointerId);
		gestureStart = null;

		if (pointers.size === 1) {
			// Pinch ended with a finger still down: re-base pan on the survivor.
			const [a] = [...pointers.values()];
			panStart = { x: a.x, y: a.y, tx, ty };
		} else if (pointers.size === 0) {
			panStart = null;
			dragging = false;
			maybeDoubleTap(event);
		}
	}

	function maybeDoubleTap(event: PointerEvent) {
		if (event.pointerType === 'mouse') return; // mouse double-click has its own handler
		if (gestureMoved || !gestureOnImage) {
			lastTap = null;
			return;
		}
		const now = performance.now();
		if (
			lastTap &&
			now - lastTap.at <= DOUBLE_TAP_MS &&
			Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= DOUBLE_TAP_TOLERANCE
		) {
			lastTap = null;
			suppressDblclickUntil = now + 500; // the WebView may still fire dblclick
			toggleZoomAt(event.clientX, event.clientY);
			return;
		}
		lastTap = { at: now, x: event.clientX, y: event.clientY };
	}

	function onDblclick(event: MouseEvent) {
		if (performance.now() < suppressDblclickUntil) return;
		if (!(event.target as HTMLElement).closest('img')) return;
		toggleZoomAt(event.clientX, event.clientY);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if current}
	<div
		bind:this={backdrop}
		class="fixed inset-0 z-50 flex touch-none items-center justify-center bg-black/90 p-4"
		role="dialog"
		aria-modal="true"
		aria-label="Image preview"
		tabindex="-1"
		onclick={(event) => {
			// Only the backdrop itself closes; clicks on the image/toolbar are not it.
			if (event.target === event.currentTarget) closeMediaLightbox();
		}}
		onkeydown={(event) => {
			if (event.key === 'Escape') closeMediaLightbox();
		}}
		onwheel={onWheel}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		ondblclick={onDblclick}
	>
		<!-- Gesture surface. touch-action:none keeps pinch/pan ours (the browser
		     no longer intercepts them); wheel/drag/pinch all drive the transform. -->
		<div
			role="presentation"
			class="flex max-h-full max-w-full touch-none items-center justify-center {dragging
				? 'cursor-grabbing'
				: 'cursor-grab'}"
		>
			<img
				bind:this={img}
				src={current.url}
				alt={current.filename}
				class="max-h-[calc(100dvh-2rem)] max-w-[calc(100dvw-2rem)] object-contain select-none"
				draggable="false"
				style={`transform: translate(${tx}px, ${ty}px) scale(${scale}); transition: ${dragging ? 'none' : 'transform 120ms ease-out'};`}
			/>
		</div>

		<div class="absolute top-safe right-3 flex items-center gap-1">
			<button
				type="button"
				class="lightbox-btn"
				onclick={() => zoomBy(-0.5)}
				disabled={scale <= MIN_SCALE}
				aria-label="Zoom out"
			>
				<ZoomOut class="size-5" />
			</button>
			<span class="min-w-[3rem] text-center text-xs text-white/70">
				{Math.round(scale * 100)}%
			</span>
			<button
				type="button"
				class="lightbox-btn"
				onclick={() => zoomBy(0.5)}
				disabled={scale >= MAX_SCALE}
				aria-label="Zoom in"
			>
				<ZoomIn class="size-5" />
			</button>
			<button
				type="button"
				class="lightbox-btn"
				onclick={reset}
				disabled={scale === 1}
				aria-label="Reset zoom"
			>
				<Home class="size-5" />
			</button>
			<button
				type="button"
				class="lightbox-btn"
				onclick={() => downloadObjectUrl(current.url, current.filename)}
				aria-label="Download"
			>
				<Download class="size-5" />
			</button>
			<button type="button" class="lightbox-btn" onclick={closeMediaLightbox} aria-label="Close">
				<X class="size-5" />
			</button>
		</div>
	</div>
{/if}

<style>
	.lightbox-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 2.25rem;
		width: 2.25rem;
		border-radius: 0.5rem;
		color: white;
		background: rgba(255, 255, 255, 0.1);
		transition: background 120ms;
	}
	.lightbox-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.2);
	}
	.lightbox-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
