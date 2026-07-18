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

	// Bootstrap the native shell (status bar, splash hide, notification taps). No-op on web.
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
