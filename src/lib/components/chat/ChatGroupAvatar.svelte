<script lang="ts">
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroupMembers, type StoredChatGroup } from '$lib/services/chatGroups.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { normalizePubKey, pubkeyToHexColor } from '$lib/utils';
	import { getDirectChatTargetPubkey } from '$lib/components/chat/chatGroupDisplay';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { getLoadAvatars } from '$lib/services/chatMediaStorage.svelte';
	import GroupAvatarFallback from './GroupAvatarFallback.svelte';

	let {
		group,
		class: className = 'h-10 w-10',
		fallbackClass = 'text-sm font-medium'
	}: {
		group: StoredChatGroup;
		class?: string;
		fallbackClass?: string;
	} = $props();

	const activePubkey = $derived.by(() =>
		$activeAccount ? normalizePubKey($activeAccount.pubkey) : ''
	);
	const otherMembers = $derived.by(() =>
		listChatGroupMembers(group.id)
			.map((member) => normalizePubKey(member.stablePubkey))
			.filter((pubkey) => pubkey && pubkey !== activePubkey)
	);
	const directChatTargetPubkey = $derived.by(() => getDirectChatTargetPubkey(group));
	const visibleMemberPubkeys = $derived.by(() =>
		(directChatTargetPubkey ? [directChatTargetPubkey] : otherMembers).slice(0, 1)
	);
	const remainingMemberCount = $derived.by(() =>
		Math.max((directChatTargetPubkey ? 1 : otherMembers.length) - visibleMemberPubkeys.length, 0)
	);
	const hasExplicitGroupAvatar = $derived.by(() =>
		Boolean(group.metadata?.imageUrl || group.metadata?.icon)
	);
	// Respect the global "load avatars" toggle — when off, skip the external image
	// fetch and show the color+initial fallback (same gate as Avatar.svelte, so the
	// group list can't drift from the bubble/profile avatars).
	const showImages = $derived(getLoadAvatars());

	const profileHints = useProfileHints(() => visibleMemberPubkeys, { relays: metadataRelays });

	function getProfile(pubkey: string) {
		return profileHints[pubkey];
	}

	function getFallback(pubkey: string) {
		const profile = getProfile(pubkey);
		return (profile?.name || profile?.displayName || pubkey).slice(0, 1).toUpperCase();
	}
</script>

{#snippet memberAvatar(pubkey: string, avatarClass: string, fbClass: string)}
	{@const profile = getProfile(pubkey)}
	<Avatar class={avatarClass}>
		{#if profile?.picture && showImages}
			<AvatarImage
				src={profile.picture}
				alt={profile.name || profile.displayName || pubkey}
				class="object-cover"
			/>
		{/if}
		<AvatarFallback
			class={`text-background ${fbClass}`}
			style={`background-color: ${pubkeyToHexColor(pubkey)};`}
		>
			{getFallback(pubkey)}
		</AvatarFallback>
	</Avatar>
{/snippet}

{#if hasExplicitGroupAvatar || visibleMemberPubkeys.length === 0}
	<Avatar class={`${className} shrink-0 border border-border bg-background`}>
		{#if group.metadata?.imageUrl && showImages}
			<AvatarImage
				src={group.metadata.imageUrl}
				alt={group.metadata?.name || group.id}
				class="object-cover"
			/>
		{/if}
		<AvatarFallback class={`bg-background ${fallbackClass}`}>
			<GroupAvatarFallback icon={group.metadata?.icon} />
		</AvatarFallback>
	</Avatar>
{:else if remainingMemberCount === 0}
	{@render memberAvatar(
		visibleMemberPubkeys[0],
		`${className} shrink-0 border border-border bg-background`,
		fallbackClass
	)}
{:else}
	<div
		class={`${className} flex shrink-0 items-center -space-x-1.5 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background`}
	>
		{#each visibleMemberPubkeys as pubkey (pubkey)}
			{@render memberAvatar(
				pubkey,
				'h-6 w-6 border border-border bg-background',
				'text-[11px] font-medium'
			)}
		{/each}
		<Avatar class="h-6 w-6 border border-border bg-muted">
			<AvatarFallback class="bg-muted text-[11px] font-medium text-muted-foreground">
				+{remainingMemberCount}
			</AvatarFallback>
		</Avatar>
	</div>
{/if}
