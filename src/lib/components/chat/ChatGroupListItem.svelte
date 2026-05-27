<script lang="ts">
	import { untrack } from 'svelte';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '$lib/services/eventStore';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroupMembers, type StoredChatGroup } from '$lib/services/chatGroups.svelte';
	import { getChatGroupDisplayTitle, type ChatGroupProfileHints } from './chatGroupDisplay';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import ChatGroupUnreadChips from './ChatGroupUnreadChips.svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { ProfileModel } from 'applesauce-core/models';
	import { Metadata } from 'nostr-tools/kinds';
	import { normalizePubKey } from '$lib/utils';

	let {
		group,
		href,
		preview,
		unreadCount = 0,
		unreadReferenceCount = 0,
		collapsed = false,
		variant = 'card',
		active = false,
		onclick
	}: {
		group: StoredChatGroup;
		href: string;
		preview: string;
		unreadCount?: number;
		unreadReferenceCount?: number;
		collapsed?: boolean;
		variant?: 'card' | 'sidebar';
		active?: boolean;
		onclick?: ((event: MouseEvent) => void) | undefined;
	} = $props();

	let groupProfileHints = $state<ChatGroupProfileHints>({});

	const isSidebar = $derived(variant === 'sidebar');
	const memberPubkeys = $derived.by(() =>
		listChatGroupMembers(group.id)
			.map((member) => normalizePubKey(member.stablePubkey))
			.filter((pubkey): pubkey is string => Boolean(pubkey))
	);
	const title = $derived.by(() =>
		getChatGroupDisplayTitle({
			group,
			activePubkey: $activeAccount?.pubkey,
			profileHints: groupProfileHints,
			memberPubkeys
		})
	);
	const linkClass = $derived.by(() => {
		if (isSidebar) {
			return `flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : 'ml-1'} ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`;
		}

		return 'group flex items-center gap-3 rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30';
	});

	$effect(() => {
		const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
		const pubkeys = [...new Set(memberPubkeys.filter((pubkey) => pubkey !== activePubkey))];
		const subscriptions = pubkeys.flatMap((pubkey) => [
			addressLoader({ kind: Metadata, pubkey, relays: metadataRelays }).subscribe(),
			eventStore.model(ProfileModel, pubkey).subscribe((profile) => {
				const current = untrack(() => groupProfileHints[pubkey]);
				const next = {
					name: profile?.name,
					displayName: profile?.display_name,
					nip05: profile?.nip05
				};

				if (
					current?.name === next.name &&
					current?.displayName === next.displayName &&
					current?.nip05 === next.nip05
				) {
					return;
				}

				groupProfileHints = { ...untrack(() => groupProfileHints), [pubkey]: next };
			})
		]);

		return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
	});
</script>

<a {href} {onclick} class={linkClass}>
	<div class="relative shrink-0">
		<ChatGroupAvatar
			{group}
			class={isSidebar ? 'h-10 w-10' : 'h-12 w-12'}
			fallbackClass={isSidebar ? 'text-sm font-medium' : 'text-base font-medium'}
		/>
		<ChatGroupUnreadChips {unreadCount} {unreadReferenceCount} />
	</div>

	{#if !collapsed}
		<div class="min-w-0 flex-1 overflow-hidden">
			<div class={isSidebar ? 'flex items-start justify-between gap-2' : 'flex items-center gap-2'}>
				<p class="truncate font-medium text-foreground">{title}</p>
				{#if !isSidebar && group.metadata?.description}
					<span class="hidden text-xs text-muted-foreground sm:inline">•</span>
					<p class="hidden truncate text-xs text-muted-foreground sm:block">
						{group.metadata.description}
					</p>
				{/if}
			</div>
			<p
				class={isSidebar
					? 'truncate text-xs leading-5 text-muted-foreground'
					: 'truncate text-sm text-muted-foreground'}
			>
				{preview}
			</p>
		</div>

		{#if !isSidebar}
			<ExternalLink
				class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
			/>
		{/if}
	{/if}
</a>
