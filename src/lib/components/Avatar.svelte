<script lang="ts">
	import { getLoadAvatars } from '$lib/services/chatMediaStorage.svelte';
	import { loadedAvatarPictures } from '$lib/components/ui/avatar/avatar-context';
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
	// Fade a never-seen picture in over the always-painted fallback color (the
	// bitmap can't paint until fetched/decoded); already-loaded pictures skip
	// the fade entirely via the session-wide set shared with `AvatarImage`.
	const loaded = $derived(picture ? loadedAvatarPictures.has(picture) : false);
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
			onload={(event) => {
				// Read the loaded element, not the prop: a virtualized row can unmount
				// while its image is still loading, and the prop then belongs to a
				// destroyed effect (Svelte's derived_inert warning).
				const src = event.currentTarget.getAttribute('src');
				if (src) loadedAvatarPictures.add(src);
			}}
		/>
	</div>
{:else}
	<div
		class={cn('rounded-full', size)}
		style={`background-color: ${pubkeyToHexColor(pubkey)}`}
	></div>
{/if}
