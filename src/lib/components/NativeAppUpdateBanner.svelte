<script lang="ts">
	import { onMount } from 'svelte';
	import Download from '@lucide/svelte/icons/download';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import {
		nativeAppUpdateStore,
		startNativeAppUpdateWatcher,
		stopNativeAppUpdateWatcher,
		dismissNativeUpdate,
		openZapstore
	} from '$lib/services/nativeAppUpdate.svelte';

	onMount(() => {
		startNativeAppUpdateWatcher();
		return () => stopNativeAppUpdateWatcher();
	});
</script>

{#if nativeAppUpdateStore.available}
	<div
		class="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 border-b border-primary-foreground/15 bg-primary px-4 py-2 text-sm text-primary-foreground shadow-lg"
		role="status"
		aria-live="polite"
	>
		<Download class="size-4 shrink-0" />
		<span class="min-w-0 truncate">
			A new version of Cordn is available
			{#if nativeAppUpdateStore.latestVersion}
				<span class="opacity-70">({nativeAppUpdateStore.latestVersion})</span>
			{/if}
		</span>
		<Button variant="secondary" size="sm" onclick={openZapstore}>Update</Button>
		<button
			type="button"
			class="absolute right-2 grid size-7 place-items-center rounded-full opacity-80 transition-opacity hover:opacity-100"
			aria-label="Dismiss update notification"
			onclick={dismissNativeUpdate}
		>
			<X class="size-4" />
		</button>
	</div>
{/if}
