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
</script>

{#if picture && showImage}
	<img src={picture} {alt} class={cn('rounded-full object-cover', size)} />
{:else}
	<div
		class={cn('rounded-full', size)}
		style={`background-color: ${pubkeyToHexColor(pubkey)}`}
	></div>
{/if}
