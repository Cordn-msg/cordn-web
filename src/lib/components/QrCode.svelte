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

			// Set the canvas display size using CSS
			canvas.style.width = `${size}px`;
			canvas.style.height = `${size}px`;
		} catch (error) {
			console.error('Failed to generate QR code:', error);
		}
	});
</script>

<div class="inline-block rounded-lg bg-white p-2 shadow-sm">
	<canvas bind:this={canvas} class="block" style="image-rendering: pixelated;"></canvas>
</div>
