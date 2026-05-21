<script lang="ts">
	import './layout.css';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Toaster } from 'svelte-sonner';
	import { ModeWatcher } from 'mode-watcher';

	let { children } = $props();
</script>

<Toaster />
<ModeWatcher />

<svelte:head><link rel="icon" href={'/cordn-logo.svg'} /></svelte:head>
<Tooltip.Provider>
	{@render children()}
</Tooltip.Provider>
