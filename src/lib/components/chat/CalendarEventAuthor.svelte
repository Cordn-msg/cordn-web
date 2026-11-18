<script lang="ts">
	import PetnameMark from '$lib/components/PetnameMark.svelte';
	import { ensureProfileLoaded } from '$lib/queries/chatProfileQueries';
	import { useProfile } from '$lib/services/useProfile.svelte';
	import { profileDisplayName } from '$lib/utils/profileName';

	/**
	 * Text-only author name at the inherited size — for compact meta lines where
	 * ProfileCard's inline mode (text-sm) would outgrow the row it sits in.
	 * Same resolution chain as everywhere else: petname → profile → short npub.
	 */
	let { pubkey }: { pubkey: string } = $props();

	const profileState = useProfile(() => pubkey);
	const name = $derived(profileDisplayName(profileState.current, pubkey));

	$effect(() => {
		if (!profileState.current) ensureProfileLoaded(pubkey);
	});
</script>

<span class="inline-flex min-w-0 items-center gap-1">
	<span class="truncate">{name}</span>
	<PetnameMark {pubkey} class="size-3" />
</span>
