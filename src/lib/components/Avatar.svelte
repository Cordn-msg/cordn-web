<script lang="ts">
	import { getLoadAvatars } from '$lib/services/chatMediaStorage.svelte';
	import { pubkeyToHexColor, cn } from '$lib/utils';

	/**
	 * Bare profile avatar: the picture when one is available AND "load avatars"
	 * is on, else the deterministic pubkey-color fallback. The single source of
	 * truth for the loadAvatars gate so the chat bubble, ProfileCard, etc. can't
	 * drift apart (the bubble avatar used to bypass this and ignore the setting).
	 */
	let {
		pubkey,
		picture,
		size = 'h-8 w-8',
		alt = ''
	}: { pubkey: string; picture?: string; size?: string; alt?: string } = $props();

	const showImage = $derived(getLoadAvatars());
	// Fade the picture in over the always-painted fallback color: the avatar
	// element remounts whenever the run's avatar hops to a newer message, and the
	// fresh <img> can't paint pixels until its bitmap is fetched/decoded. The
	// crossfade turns that into a smooth transition instead of a color flash.
	let loaded = $state(false);
</script>

{#if picture && showImage}
	<div
		class={cn('overflow-hidden rounded-full', size)}
		style={`background-color: ${pubkeyToHexColor(pubkey)}`}
	>
		<img
			src={picture}
			{alt}
			class={cn(
				'h-full w-full object-cover transition-opacity duration-200',
				loaded ? 'opacity-100' : 'opacity-0'
			)}
			decoding="sync"
			onload={() => (loaded = true)}
		/>
	</div>
{:else}
	<div
		class={cn('rounded-full', size)}
		style={`background-color: ${pubkeyToHexColor(pubkey)}`}
	></div>
{/if}
