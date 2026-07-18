<script lang="ts">
	import './layout.css';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Toaster } from 'svelte-sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query-client';
	import AppUpdateBanner from '$lib/components/AppUpdateBanner.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { initNativeShell, isNativePlatform } from '$lib/services/nativeBridge';

	let { children } = $props();

	// Native: skip the landing page — open straight to /chat (mirrors the PWA start_url).
	// Web is a no-op. Deep links (e.g. notification taps to /chat/[id]) are preserved.
	onMount(() => {
		if (isNativePlatform() && page.url.pathname === '/') {
			void goto(resolve('/chat'), { replaceState: true });
		}
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
