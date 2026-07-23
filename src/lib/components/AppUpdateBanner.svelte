<script lang="ts">
	import { onMount } from 'svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import {
		appUpdateStore,
		startAppUpdateWatcher,
		stopAppUpdateWatcher,
		reloadForUpdate,
		dismissUpdate
	} from '$lib/services/appUpdate.svelte';

	onMount(() => {
		startAppUpdateWatcher();
		return () => stopAppUpdateWatcher();
	});

	// Product version when known, else the SHA. Display only — the comparison key stays the SHA.
	const displayVersion = $derived(appUpdateStore.latestSemver ?? appUpdateStore.latestVersion);
</script>

{#if appUpdateStore.available}
	<div
		class="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 border-b border-primary-foreground/15 bg-primary px-4 py-2 text-sm text-primary-foreground shadow-lg"
		role="status"
		aria-live="polite"
	>
		<RefreshCw class="size-4 shrink-0" />
		<span class="min-w-0 truncate">
			A new version of Cordn is available
			{#if displayVersion}
				<span class="opacity-70">({displayVersion})</span>
			{/if}
		</span>
		<Button variant="secondary" size="sm" onclick={reloadForUpdate}>Reload</Button>
		<button
			type="button"
			class="absolute right-2 grid size-7 place-items-center rounded-full opacity-80 transition-opacity hover:opacity-100"
			aria-label="Dismiss update notification"
			onclick={dismissUpdate}
		>
			<X class="size-4" />
		</button>
	</div>
{/if}
