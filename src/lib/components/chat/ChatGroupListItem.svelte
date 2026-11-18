<script lang="ts">
	import { metadataRelays } from '$lib/services/relay-pool';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroupMembers, type StoredChatGroup } from '$lib/services/chatGroups.svelte';
	import {
		formatChatMessagePreviewText,
		getChatGroupDisplayTitle,
		getChatGroupTitlePersonPubkey,
		type ChatGroupProfileHints
	} from './chatGroupDisplay';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import ChatGroupUnreadChips from './ChatGroupUnreadChips.svelte';
	import ChatGroupActions from './ChatGroupActions.svelte';
	import PetnameMark from '$lib/components/PetnameMark.svelte';
	import { normalizePubKey } from '$lib/utils';
	import {
		getChatCoordinator,
		getCoordinatorColor,
		getCoordinatorLabel
	} from '$lib/services/chatCoordinators.svelte';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { isChatGroupPinned } from '$lib/services/chatGroupPins.svelte';
	import { getChatGroupMuteLabel, isChatGroupMuted } from '$lib/services/chatGroupMutes.svelte';
	import {
		groupCallCards,
		groupCallWindowSignature,
		loadGroupCalls
	} from '$lib/services/chatCalls.svelte';
	import { liveCallCard } from '$lib/chat/calls';
	import { untrack } from 'svelte';
	import Pin from '@lucide/svelte/icons/pin';
	import BellOff from '@lucide/svelte/icons/bell-off';
	import Phone from '@lucide/svelte/icons/phone';

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
	// A 1:1 title is the peer's name, so a petname there needs the same mark as
	// the bubbles; an explicit group name or a "Alice +2" summary has no owner.
	const titlePersonPubkey = $derived(
		getChatGroupTitlePersonPubkey({
			group,
			activePubkey: $activeAccount?.pubkey,
			memberPubkeys
		})
	);
	const showActions = $derived(!collapsed);
	// Coordinator accent for the sidebar dot, derived internally so no call site
	// threads props. Falls back to the deterministic derived color when the
	// coordinator isn't in the local store.
	const coordinatorAccent = $derived.by(() => {
		const stored = getChatCoordinator(group.coordinatorKey);
		return {
			color: getCoordinatorColor(stored ?? { pubkey: group.coordinatorKey, color: undefined }),
			label: getCoordinatorLabel(group.coordinatorKey)
		};
	});
	const pinned = $derived(isChatGroupPinned(group.id));
	const muted = $derived(isChatGroupMuted(group.id));
	const muteLabel = $derived(getChatGroupMuteLabel(group.id));
	// Presence, not attention: a live call is a badge on the avatar only. It stays out of
	// the unread counts, sorting and notifications, which keep their own sources.
	const callLive = $derived(liveCallCard(groupCallCards(group.id)) !== null);
	const callWindowSignature = $derived(groupCallWindowSignature(group.id));
	$effect(() => {
		// A close can leave the window before the durable read saw it: re-read on any
		// change to the group's call rows so an ended call cannot reappear as live.
		void callWindowSignature;
		const id = group.id;
		untrack(() => void loadGroupCalls(id, { force: true }));
	});

	// Anchor is a sibling of the action button (not its parent) so the button
	// click never navigates and we avoid nested interactive elements.
	const linkClass = $derived.by(() => {
		if (isSidebar) {
			return `flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : 'ml-1'} ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`;
		}

		return 'group flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30';
	});
	const containerClass = $derived(
		isSidebar ? 'flex items-center gap-1' : 'group flex items-center gap-1'
	);
</script>

<div class={containerClass}>
	<!-- The caller passes route hrefs resolved with $app/paths when route params are needed. -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a {href} {onclick} class={linkClass}>
		{#if isSidebar && active && !collapsed}
			<span
				class="size-1.5 shrink-0 rounded-full"
				style={`background-color: ${coordinatorAccent.color};`}
				title={coordinatorAccent.label}
				aria-hidden="true"
			></span>
		{/if}
		<div class="relative shrink-0">
			<ChatGroupAvatar
				{group}
				class={isSidebar ? 'h-10 w-10' : 'h-12 w-12'}
				fallbackClass={isSidebar ? 'text-sm font-medium' : 'text-base font-medium'}
			/>
			<ChatGroupUnreadChips {unreadCount} {unreadReferenceCount} />
			{#if callLive}
				<span
					class="absolute -bottom-1 -left-1 flex size-5 items-center justify-center rounded-full bg-emerald-500 text-white"
					aria-hidden="true"
				>
					<Phone class="size-3" />
				</span>
				<span class="sr-only">Call in progress</span>
			{/if}
		</div>

		{#if !collapsed}
			<div class="min-w-0 flex-1 overflow-hidden">
				<div
					class={isSidebar ? 'flex items-start justify-between gap-2' : 'flex items-center gap-2'}
				>
					<p class="flex min-w-0 items-center gap-1 font-medium text-foreground">
						{#if pinned}
							<Pin
								class="size-3 shrink-0 text-muted-foreground"
								aria-label="Pinned to top"
								title="Pinned to top"
							/>
						{/if}
						{#if muted}
							<BellOff
								class="size-3 shrink-0 text-muted-foreground"
								aria-label={muteLabel}
								title={muteLabel}
							/>
						{/if}
						<span class="truncate">{title}</span>
						<PetnameMark pubkey={titlePersonPubkey} class="size-3.5" />
					</p>
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
					{formatChatMessagePreviewText(preview, hints)}
				</p>
			</div>
		{/if}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->

	{#if showActions}
		<ChatGroupActions {group} {title} profileHints={hints} />
	{/if}
</div>
