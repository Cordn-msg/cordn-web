<script lang="ts">
	import './layout.css';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Toaster } from 'svelte-sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query-client';
	import AppUpdateBanner from '$lib/components/AppUpdateBanner.svelte';
	import { onMount } from 'svelte';
	import { initNativeShell } from '$lib/services/nativeBridge';

	let { children } = $props();

	// Native cold-start lands on /chat via capacitor.config.ts `server.appStartPath` (the
	// WebView's first URL is https://localhost/chat), so no client redirect is needed here.
	// Deep links and notification taps override it via their launch URL.
	onMount(() => {
		void initNativeShell();
	});
</script>

<Toaster />
<ModeWatcher />
<AppUpdateBanner />

<svelte:head><link rel="icon" href="/favicon.svg" /></svelte:head>
<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		{@render children()}
	</Tooltip.Provider>
</QueryClientProvider>
