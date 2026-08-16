<script lang="ts">
	import { getContext } from 'svelte';
	import type { HTMLImgAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import { AVATAR_STATUS_KEY, type AvatarStatusContext } from './avatar-context.js';

	let {
		ref = $bindable(null),
		src = undefined,
		class: className,
		style = undefined,
		...restProps
	}: WithElementRef<HTMLImgAttributes> = $props();

	const avatar = getContext<AvatarStatusContext>(AVATAR_STATUS_KEY);

	// Preload with a detached image so the visible <img> never flashes a
	// half-loaded state. Cleanup detaches the handlers: nothing may fire (or
	// touch component state) after this component is destroyed.
	$effect(() => {
		if (!src) {
			avatar.set('error');
			return;
		}
		const image = new Image();
		image.src = src;
		image.onload = () => avatar.set('loaded');
		image.onerror = () => avatar.set('error');
		return () => {
			image.onload = null;
			image.onerror = null;
		};
	});
</script>

<img
	bind:this={ref}
	{src}
	data-slot="avatar-image"
	data-status={avatar.status}
	style:display={avatar.status === 'loaded' ? 'block' : 'none'}
	{style}
	class={cn('aspect-square size-full rounded-full object-cover', className)}
	{...restProps}
/>
