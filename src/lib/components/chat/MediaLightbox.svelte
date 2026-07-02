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

	let backdrop: HTMLDivElement | null = $state(null);
	let scale = $state(1);
	let tx = $state(0);
	let ty = $state(0);
	let dragging = $state(false);
	let startX = 0;
	let startY = 0;
	let baseX = 0;
	let baseY = 0;

	// Reset transforms and move focus into the dialog whenever a new image opens.
	$effect(() => {
		if (!current) return;
		scale = 1;
		tx = 0;
		ty = 0;
		void tick().then(() => backdrop?.focus());
	});

	function onWindowKeydown(event: KeyboardEvent) {
		if (current && event.key === 'Escape') closeMediaLightbox();
	}

	function zoomBy(delta: number) {
		scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((scale + delta).toFixed(2))));
		// At or below fit the image is centered, so snap pan back to origin.
		if (scale <= 1) {
			tx = 0;
			ty = 0;
		}
	}

	function reset() {
		scale = 1;
		tx = 0;
		ty = 0;
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		zoomBy(event.deltaY < 0 ? 0.25 : -0.25);
	}

	function onPointerDown(event: PointerEvent) {
		dragging = true;
		startX = event.clientX;
		startY = event.clientY;
		baseX = tx;
		baseY = ty;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging) return;
		tx = baseX + (event.clientX - startX);
		ty = baseY + (event.clientY - startY);
	}

	function onPointerUp() {
		dragging = false;
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if current}
	<div
		bind:this={backdrop}
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
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
	>
		<!-- Pan/zoom surface. Keyboard equivalents (zoom buttons, Esc) live on the
		     toolbar and window; wheel/drag are mouse/gesture conveniences. -->
		<div
			role="presentation"
			class="flex max-h-full max-w-full touch-manipulation items-center justify-center {dragging
				? 'cursor-grabbing'
				: 'cursor-grab'}"
			onwheel={onWheel}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			ondblclick={reset}
		>
			<img
				src={current.url}
				alt={current.filename}
				class="max-h-[calc(100dvh-2rem)] max-w-[calc(100dvw-2rem)] object-contain select-none"
				draggable="false"
				style={`transform: translate(${tx}px, ${ty}px) scale(${scale}); transition: ${dragging ? 'none' : 'transform 120ms ease-out'};`}
			/>
		</div>

		<div class="absolute top-3 right-3 flex items-center gap-1">
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
