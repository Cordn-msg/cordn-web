<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import { activeAccount } from '$lib/services/accountManager.svelte';

	// NIP-44 v2 is load-bearing beyond multi-device: the coordinator's stable
	// lane (key packages, join requests, welcomes) and the multi-device tip seal
	// all decrypt through the active signer. Some NIP-07 extensions and bunkers
	// don't expose it — messaging still works there, so without this banner the
	// failure is invisible until each affected flow times out.
	const missing = $derived(!!$activeAccount && !$activeAccount.nip44);
</script>

{#if missing}
	<div
		class="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-sm"
		role="status"
		aria-live="polite"
	>
		<AlertTriangle class="size-4 shrink-0 text-amber-500" />
		<span>
			This signer doesn't support NIP-44 v2. Messaging works, but joining groups, invites and
			multi-device sync won't — switch to a signer that supports it.
		</span>
	</div>
{/if}
