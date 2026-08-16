<script lang="ts">
	import { setContext } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import {
		AVATAR_STATUS_KEY,
		type AvatarLoadingStatus,
		type AvatarStatusContext
	} from './avatar-context.js';

	let {
		ref = $bindable(null),
		size = 'default',
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		size?: 'default' | 'sm' | 'lg';
	} = $props();

	let loadingStatus = $state<AvatarLoadingStatus>('loading');

	setContext(AVATAR_STATUS_KEY, {
		get status() {
			return loadingStatus;
		},
		set: (next: AvatarLoadingStatus) => (loadingStatus = next)
	} satisfies AvatarStatusContext);
</script>

<div
	bind:this={ref}
	data-slot="avatar"
	data-size={size}
	class={cn(
		'group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
