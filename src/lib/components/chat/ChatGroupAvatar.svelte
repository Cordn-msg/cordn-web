<script lang="ts">
	import { untrack } from 'svelte';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroupMembers, type StoredChatGroup } from '$lib/services/chatGroups.svelte';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { eventStore } from '$lib/services/eventStore';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { normalizePubKey, pubkeyToHexColor } from '$lib/utils';
	import { getDirectChatTargetPubkey } from '$lib/components/chat/chatGroupDisplay';
	import { ProfileModel } from 'applesauce-core/models';
	import { Metadata } from 'nostr-tools/kinds';

	let {
		group,
		class: className = 'h-10 w-10',
		fallbackClass = 'text-sm font-medium'
	}: {
		group: StoredChatGroup;
		class?: string;
		fallbackClass?: string;
	} = $props();

	let profileHints = $state<
		Record<string, { picture?: string; name?: string; displayName?: string }>
	>({});

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

	function getProfile(pubkey: string) {
		return profileHints[pubkey];
	}

	function getFallback(pubkey: string) {
		const profile = getProfile(pubkey);
		return (profile?.name || profile?.displayName || pubkey).slice(0, 1).toUpperCase();
	}

	function getGroupFallback() {
		return group.metadata?.icon || group.metadata?.name?.slice(0, 1) || '#';
	}

	$effect(() => {
		const subscriptions = visibleMemberPubkeys.flatMap((pubkey) => [
			addressLoader({
				kind: Metadata,
				pubkey,
				relays: metadataRelays
			}).subscribe(),
			eventStore.model(ProfileModel, pubkey).subscribe((profile) => {
				const current = untrack(() => profileHints[pubkey]);
				const next = {
					picture: profile?.picture,
					name: profile?.name,
					displayName: profile?.display_name
				};

				if (
					current?.picture === next.picture &&
					current?.name === next.name &&
					current?.displayName === next.displayName
				) {
					return;
				}

				profileHints = {
					...untrack(() => profileHints),
					[pubkey]: next
				};
			})
		]);

		return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
	});
</script>

{#if hasExplicitGroupAvatar || visibleMemberPubkeys.length === 0}
	<Avatar class={`${className} shrink-0 border border-border bg-background`}>
		{#if group.metadata?.imageUrl}
			<AvatarImage
				src={group.metadata.imageUrl}
				alt={group.metadata?.name || group.id}
				class="object-cover"
			/>
		{/if}
		<AvatarFallback class={`bg-background ${fallbackClass}`}>{getGroupFallback()}</AvatarFallback>
	</Avatar>
{:else if remainingMemberCount === 0}
	{@const pubkey = visibleMemberPubkeys[0]}
	{@const profile = getProfile(pubkey)}
	<Avatar class={`${className} shrink-0 border border-border bg-background`}>
		{#if profile?.picture}
			<AvatarImage
				src={profile.picture}
				alt={profile.name || profile.displayName || pubkey}
				class="object-cover"
			/>
		{/if}
		<AvatarFallback
			class={`text-background ${fallbackClass}`}
			style={`background-color: ${pubkeyToHexColor(pubkey)};`}
		>
			{getFallback(pubkey)}
		</AvatarFallback>
	</Avatar>
{:else}
	<div
		class={`${className} flex shrink-0 items-center -space-x-1.5 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background`}
	>
		{#each visibleMemberPubkeys as pubkey (pubkey)}
			{@const profile = getProfile(pubkey)}
			<Avatar class="h-6 w-6 border border-border bg-background">
				{#if profile?.picture}
					<AvatarImage
						src={profile.picture}
						alt={profile.name || profile.displayName || pubkey}
						class="object-cover"
					/>
				{/if}
				<AvatarFallback
					class="text-[11px] font-medium text-background"
					style={`background-color: ${pubkeyToHexColor(pubkey)};`}
				>
					{getFallback(pubkey)}
				</AvatarFallback>
			</Avatar>
		{/each}
		<Avatar class="h-6 w-6 border border-border bg-muted">
			<AvatarFallback class="bg-muted text-[11px] font-medium text-muted-foreground">
				+{remainingMemberCount}
			</AvatarFallback>
		</Avatar>
	</div>
{/if}
