<script lang="ts">
	import { generate } from 'lean-qr';
	import { onMount } from 'svelte';

	let {
		data,
		size = 200
	}: {
		data: string;
		size?: number;
	} = $props();

	let canvas: HTMLCanvasElement;

	onMount(() => {
		if (!data) return;

		try {
			const code = generate(data);
			code.toCanvas(canvas, {
				on: [0, 0, 0, 255], // black
				off: [255, 255, 255, 255], // white background
				padX: 4,
				padY: 4
			});

			// Render fluid so the dialog never overflows on narrow screens; the
			// wrapper caps the width at `size` (see below).
			canvas.style.width = '100%';
			canvas.style.height = 'auto';
		} catch (error) {
			console.error('Failed to generate QR code:', error);
		}
	});
</script>

<div class="block w-full rounded-lg bg-white p-2 shadow-sm" style="max-width: {size}px">
	<canvas bind:this={canvas} class="block" style="image-rendering: pixelated;"></canvas>
</div>
