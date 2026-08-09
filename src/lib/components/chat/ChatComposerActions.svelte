<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import Plus from '@lucide/svelte/icons/plus';
	import Camera from '@lucide/svelte/icons/camera';
	import Video from '@lucide/svelte/icons/video';
	import ImageIcon from '@lucide/svelte/icons/image';
	import FileText from '@lucide/svelte/icons/file-text';
	import { isNativePlatform } from '$lib/services/nativeShims';

	/**
	 * Composer actions menu — the `+` next to the composer. Camera capture (photo on all platforms,
	 * video native-only), plus image/document pickers. A discrete, exported component so further
	 * non-media actions (polls, payments, etc.) can be appended to the same dropdown later without
	 * touching the composer.
	 */
	let {
		onTakePhoto = () => {},
		onTakeVideo = () => {},
		onPickImage = () => {},
		onPickDocument = () => {}
	}: {
		onTakePhoto?: () => void;
		onTakeVideo?: () => void;
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
		<DropdownMenu.Item onclick={onTakePhoto} class="gap-2">
			<Camera class="size-4" />
			<span>Take Photo</span>
		</DropdownMenu.Item>
		{#if isNativePlatform()}
			<DropdownMenu.Item onclick={onTakeVideo} class="gap-2">
				<Video class="size-4" />
				<span>Record Video</span>
			</DropdownMenu.Item>
		{/if}
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
