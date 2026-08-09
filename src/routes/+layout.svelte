<script lang="ts">
	import './layout.css';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Toaster } from 'svelte-sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query-client';
	import AppUpdateBanner from '$lib/components/AppUpdateBanner.svelte';
	import NativeAppUpdateBanner from '$lib/components/NativeAppUpdateBanner.svelte';
	import { onMount } from 'svelte';
	import { initNativeShell } from '$lib/services/nativeBridge';
	import { defineCustomElements } from '@ionic/pwa-elements/loader';

	let { children } = $props();

	// Native cold-start lands on /chat via capacitor.config.ts `server.appStartPath` (the
	// WebView's first URL is https://localhost/chat), so no client redirect is needed here.
	// Deep links and notification taps override it via their launch URL.
	onMount(() => {
		// Register @ionic/pwa-elements' web components (pwa-camera-modal) once, lazily. @capacitor/camera's
		// web `takePhoto` looks up `pwa-camera-modal` via customElements.get(); without this registration it
		// logs a warning and falls back to a plain file input (which made 'Take Photo' duplicate 'Image' on
		// web). Harmless no-op on native, where takePhoto uses the real camera intent.
		defineCustomElements(window);
		void initNativeShell();
	});
</script>

<Toaster />
<ModeWatcher />
<AppUpdateBanner />
<NativeAppUpdateBanner />

<svelte:head><link rel="icon" href="/favicon.svg" /></svelte:head>
<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		{@render children()}
	</Tooltip.Provider>
</QueryClientProvider>
