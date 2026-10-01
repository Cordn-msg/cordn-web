<script lang="ts">
	import { useProfile } from '$lib/services/useProfile.svelte';
	import { ensureProfileLoaded } from '$lib/queries/chatProfileQueries';
	import { profileDisplayName } from '$lib/utils/profileName';

	/** One truncating name chip inside a Marker row (reaction timeline).
	 *  Same fallback chain and span styling as the system-message `systemName`
	 *  snippet — ProfileCard inline is deliberately NOT used (text-sm + wrapping
	 *  break the text-xs prose flow of marker rows). */
	let { pubkey }: { pubkey: string } = $props();

	const profile = useProfile(() => pubkey);
	const name = $derived(profileDisplayName(profile.current, pubkey) ?? 'Someone');

	$effect(() => {
		if (!profile.current) ensureProfileLoaded(pubkey);
	});
</script>

<span
	class="inline-block max-w-[28ch] truncate align-bottom font-medium text-foreground/90"
	title={name}>{name}</span
>
