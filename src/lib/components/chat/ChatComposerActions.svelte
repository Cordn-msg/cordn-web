<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import Plus from '@lucide/svelte/icons/plus';
	import ImageIcon from '@lucide/svelte/icons/image';
	import FileText from '@lucide/svelte/icons/file-text';

	/**
	 * Composer actions menu — the `+` next to the composer. Today it only opens
	 * media pickers (image / document); it is intentionally a discrete, exported
	 * component so non-media actions (polls, payments, etc.) can be appended to
	 * the same dropdown later without touching the composer.
	 */
	let {
		onPickImage = () => {},
		onPickDocument = () => {}
	}: {
		onPickImage?: () => void;
		onPickDocument?: () => void;
	} = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				type="button"
				variant="ghost"
				size="icon"
				class="h-11 w-11 shrink-0 rounded-xl"
				aria-label="Add attachment"
				title="Add attachment"
			>
				<Plus class="size-4" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" side="top" class="w-48">
		<DropdownMenu.Item onclick={onPickImage} class="gap-2">
			<ImageIcon class="size-4" />
			<span>Image</span>
		</DropdownMenu.Item>
		<DropdownMenu.Item onclick={onPickDocument} class="gap-2">
			<FileText class="size-4" />
			<span>Document</span>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
