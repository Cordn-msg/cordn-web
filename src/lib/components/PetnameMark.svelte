<script lang="ts">
	import PawPrint from '@lucide/svelte/icons/paw-print';
	import { getChatPetname } from '$lib/services/chatPetnames.svelte';

	/**
	 * Flags a name that is this device's own label rather than the person's
	 * self-declared one. Renders nothing when there is no petname, so call sites
	 * stay a single line and the "no label, no mark" rule lives here.
	 */
	let { pubkey, class: className = 'size-3.5' }: { pubkey: string; class?: string } = $props();
</script>

{#if getChatPetname(pubkey)}
	<PawPrint
		class={`shrink-0 text-muted-foreground ${className}`}
		role="img"
		aria-label="Your petname for this person"
	/>
{/if}
