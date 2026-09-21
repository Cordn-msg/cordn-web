<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import { onMount } from 'svelte';
	import { manager } from '$lib/services/accountManager.svelte';

	// `account.nip44` is a plain getter over the extension's `window.nostr`
	// object, not a reactive signal — extensions inject asynchronously, so a
	// single read at mount can false-positive. Poll instead: the banner only
	// appears once absence is actually observed, and a late injection clears it
	// on the next tick. A 1s getter read is effectively free.
	let missing = $state(false);

	onMount(() => {
		const id = setInterval(() => {
			const account = manager.getActive();
			missing = !!account && !account.nip44;
		}, 1000);
		return () => clearInterval(id);
	});
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
