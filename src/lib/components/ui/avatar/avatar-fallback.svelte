<script lang="ts">
	import { getContext } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import { AVATAR_STATUS_KEY, type AvatarStatusContext } from './avatar-context.js';

	let {
		ref = $bindable(null),
		class: className,
		style = undefined,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> = $props();

	const avatar = getContext<AvatarStatusContext>(AVATAR_STATUS_KEY);
</script>

{#if avatar.status !== 'loaded'}
	<span
		bind:this={ref}
		data-slot="avatar-fallback"
		data-status={avatar.status}
		class={cn(
			'flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs',
			className
		)}
		{style}
		{...restProps}
	>
		{@render children?.()}
	</span>
{/if}
