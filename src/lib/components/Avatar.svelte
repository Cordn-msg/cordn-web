<script module lang="ts">
	import { SvelteSet } from 'svelte/reactivity';

	/** Pictures already fetched + decoded this session. Module scope on purpose:
	 *  a remounted avatar (group open, scrolling back into the virtual window) must
	 *  paint its bitmap at full opacity immediately instead of replaying the load
	 *  fade for an image the browser already has. */
	const loadedPictures = new SvelteSet<string>();
</script>

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
	// Fade a never-seen picture in over the always-painted fallback color (the
	// bitmap can't paint until fetched/decoded); already-loaded pictures skip
	// the fade entirely via the session-wide set above.
	const loaded = $derived(picture ? loadedPictures.has(picture) : false);
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
			onload={() => picture && loadedPictures.add(picture)}
		/>
	</div>
{:else}
	<div
		class={cn('rounded-full', size)}
		style={`background-color: ${pubkeyToHexColor(pubkey)}`}
	></div>
{/if}
