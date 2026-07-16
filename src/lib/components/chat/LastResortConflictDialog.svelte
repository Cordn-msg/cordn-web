<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import {
		foreignLastResortPrompt,
		resolveForeignLastResortPrompt
	} from '$lib/services/lastResortConflict.svelte';
	import { takeOverLastResort } from '$lib/services/chatKeyPackages.svelte';

	const open = $derived(foreignLastResortPrompt.pending !== null);
	const coordinatorKey = $derived(foreignLastResortPrompt.pending?.coordinatorKey ?? '');

	let takingOver = $state(false);

	async function handleTakeOver() {
		if (
			!confirm(
				'Publish a key package from this device instead? This replaces the one your other device published — pending invites that referenced it may need to be resent.'
			)
		) {
			return;
		}
		takingOver = true;
		try {
			const ref = await takeOverLastResort(coordinatorKey);
			toast.success('This device is now reachable for invites');
			resolveForeignLastResortPrompt(ref);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not publish from this device');
		} finally {
			takingOver = false;
		}
	}

	function handleLink() {
		// The path is resolved before appending the local query parameter.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(`${resolve('/chat/config/multi-device')}?tab=link`);
		resolveForeignLastResortPrompt(null);
	}

	function handleDismiss() {
		resolveForeignLastResortPrompt(null);
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(v) => {
		if (!v && !takingOver) handleDismiss();
	}}
>
	<Dialog.Content class="sm:max-w-[480px]">
		<Dialog.Header>
			<Dialog.Title>Key package found on another device</Dialog.Title>
			<Dialog.Description>
				Another device already published your always-reachable key package. Publishing from here
				would replace it. Link your devices to share it, or take over from this device.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="flex-col gap-2 sm:flex-row">
			<Button onclick={handleLink} class="sm:mr-auto">Link this device</Button>
			<Button variant="outline" onclick={handleDismiss} disabled={takingOver}>Not now</Button>
			<Button variant="destructive" onclick={handleTakeOver} disabled={takingOver}>
				{#if takingOver}<Spinner class="mr-2 size-4" />{/if}
				{takingOver ? 'Publishing…' : 'Use this device instead'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
