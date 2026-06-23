<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import Heart from '@lucide/svelte/icons/heart';

	let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Heart class="size-4" />
				Support Cordn
			</Dialog.Title>
			<Dialog.Description>
				Thanks for your interest in supporting Cordn. Donation options are coming soon.
			</Dialog.Description>
		</Dialog.Header>
		<div class="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
			Placeholder — payment integrations will be wired up here.
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
