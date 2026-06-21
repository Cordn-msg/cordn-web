<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import QrScanner from 'qr-scanner';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import CameraOff from '@lucide/svelte/icons/camera-off';

	let {
		onResult
	}: {
		onResult: (data: string) => void;
	} = $props();

	let video: HTMLVideoElement;
	let scanner: QrScanner | null = null;

	type Status = 'starting' | 'scanning' | 'denied' | 'no-camera' | 'error';
	let status = $state<Status>('starting');
	let errorMessage = $state('');

	const failed = $derived(status !== 'starting' && status !== 'scanning');

	async function start() {
		status = 'starting';
		errorMessage = '';
		try {
			if (!scanner) {
				scanner = new QrScanner(video, (result) => onResult(result.data), {
					preferredCamera: 'environment',
					highlightScanRegion: true,
					highlightCodeOutline: true,
					returnDetailedScanResult: true
				});
			}
			const hasCamera = await QrScanner.hasCamera();
			if (!hasCamera) {
				status = 'no-camera';
				return;
			}
			await scanner.start();
			status = 'scanning';
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/permission|denied|not.?allowed/i.test(message)) {
				status = 'denied';
			} else {
				status = 'error';
				errorMessage = message;
			}
		}
	}

	onMount(() => {
		if (!browser) return;
		void start();
		return () => {
			scanner?.destroy();
			scanner = null;
		};
	});
</script>

<div class="relative aspect-square w-full max-w-[220px] overflow-hidden rounded-lg bg-black">
	<video bind:this={video} class="block h-full w-full object-cover" muted playsinline></video>

	{#if status === 'starting'}
		<div class="absolute inset-0 flex items-center justify-center bg-black/60">
			<Spinner class="size-6" />
		</div>
	{/if}

	{#if failed}
		<div
			class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-4 text-center"
		>
			<CameraOff class="size-6 text-muted-foreground" />
			<p class="text-xs text-muted-foreground">
				{#if status === 'denied'}
					Camera access was blocked. Enable it in your browser and try again.
				{:else if status === 'no-camera'}
					No camera found on this device.
				{:else}
					{errorMessage || 'Could not start the camera.'}
				{/if}
			</p>
			<Button type="button" variant="outline" size="sm" onclick={() => void start()}>
				Try again
			</Button>
		</div>
	{/if}
</div>
