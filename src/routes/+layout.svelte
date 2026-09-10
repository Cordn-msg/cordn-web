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

	// Safe-area-aware toast offsets: keep svelte-sonner's stock bases (24px desktop / 16px mobile)
	// and add the bar insets on top, so toasts clear the gesture/nav bar in the native edge-to-edge
	// shell. Inert on web — insets resolve to 0px and rendering matches library defaults exactly.
	// Per-side calcs (not one string) because a single string value is assigned to all four sides.
	const toastInsets = (base: string) => ({
		top: `calc(${base} + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))`,
		right: `calc(${base} + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))`,
		bottom: `calc(${base} + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))`,
		left: `calc(${base} + var(--safe-area-inset-left, env(safe-area-inset-left, 0px)))`
	});

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

<Toaster offset={toastInsets('24px')} mobileOffset={toastInsets('16px')} />
<ModeWatcher />
<AppUpdateBanner />
<NativeAppUpdateBanner />

<svelte:head><link rel="icon" href="/favicon.svg" /></svelte:head>
<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		{@render children()}
	</Tooltip.Provider>
</QueryClientProvider>
