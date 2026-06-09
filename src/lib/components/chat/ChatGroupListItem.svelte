<script lang="ts">
	import { metadataRelays } from '$lib/services/relay-pool';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroupMembers, type StoredChatGroup } from '$lib/services/chatGroups.svelte';
	import { getChatGroupDisplayTitle, type ChatGroupProfileHints } from './chatGroupDisplay';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import ChatGroupUnreadChips from './ChatGroupUnreadChips.svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { normalizePubKey } from '$lib/utils';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';

	let {
		group,
		href,
		preview,
		unreadCount = 0,
		unreadReferenceCount = 0,
		collapsed = false,
		variant = 'card',
		active = false,
		onclick,
		profileHints
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
		profileHints?: ChatGroupProfileHints;
	} = $props();

	const isSidebar = $derived(variant === 'sidebar');
	const memberPubkeys = $derived.by(() =>
		listChatGroupMembers(group.id)
			.map((member) => normalizePubKey(member.stablePubkey))
			.filter((pubkey): pubkey is string => Boolean(pubkey))
	);

	const groupProfileHints = useProfileHints(
		() => {
			if (profileHints) return [];
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			return [...new Set(memberPubkeys.filter((pubkey) => pubkey !== activePubkey))];
		},
		{ relays: metadataRelays }
	);

	const hints = $derived(profileHints ?? groupProfileHints);
	const title = $derived.by(() =>
		getChatGroupDisplayTitle({
			group,
			activePubkey: $activeAccount?.pubkey,
			profileHints: hints,
			memberPubkeys
		})
	);
	const linkClass = $derived.by(() => {
		if (isSidebar) {
			return `flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : 'ml-1'} ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`;
		}

		return 'group flex items-center gap-3 rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30';
	});
</script>

<!-- The caller passes route hrefs resolved with $app/paths when route params are needed. -->
<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
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
