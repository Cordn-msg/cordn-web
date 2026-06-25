<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import {
		getCoordinatorPurgeImpact,
		purgeChatCoordinator,
		type CoordinatorPurgeImpact
	} from '$lib/services/chatCoordinatorActions.svelte';

	let {
		pubkey,
		label,
		open = $bindable(false),
		onpurged
	}: {
		pubkey: string;
		label: string;
		open?: boolean;
		onpurged?: () => void;
	} = $props();

	let purging = $state(false);
	const impact = $derived<CoordinatorPurgeImpact>(getCoordinatorPurgeImpact(pubkey));

	async function handlePurge() {
		purging = true;
		try {
			await purgeChatCoordinator(pubkey);
			onpurged?.();
		} finally {
			purging = false;
			open = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-[480px]">
		<Dialog.Header>
			<Dialog.Title>Remove coordinator?</Dialog.Title>
			<Dialog.Description>
				This removes <span class="font-medium text-foreground">{label}</span> and deletes everything
				associated with it from this browser: {impact.groups} group{impact.groups === 1 ? '' : 's'}, {impact.keyPackagesPublished}
				key package{impact.keyPackagesPublished === 1 ? '' : 's'} published to the coordinator, plus {impact.keyPackagesLocal}
				consumed local record{impact.keyPackagesLocal === 1 ? '' : 's'}, and {impact.welcomes} welcome{impact.welcomes ===
				1
					? ''
					: 's'}. Messages and membership on other devices or coordinators are not affected.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={purging}>Cancel</Button>
			<Button variant="destructive" onclick={handlePurge} disabled={purging}>
				{#if purging}<Spinner class="mr-2 size-4" />{/if}
				{purging ? 'Removing…' : 'Remove coordinator'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
