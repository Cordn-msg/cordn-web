<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import GroupAvatarFallback from './GroupAvatarFallback.svelte';
	import QrShareDialog from '$lib/components/QrShareDialog.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ChatSearchBar from '$lib/components/chat/ChatSearchBar.svelte';
	import ChatGroupActions from '$lib/components/chat/ChatGroupActions.svelte';
	import AvailableKeyPackageDirectory from '$lib/components/chat/AvailableKeyPackageDirectory.svelte';
	import type { AvailableKeyPackageWithCoordinator } from '$lib/queries/chatKeyPackageQueries';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import PetnameMark from '$lib/components/PetnameMark.svelte';
	import { resolve } from '$app/paths';
	import {
		chatGroupInfoActionsStore,
		chatHeaderActionsStore,
		checkChatGroupMessagesAction,
		inviteGroupMemberAction,
		refreshInviteKeyPackagesAction,
		repairChatGroupAction
	} from '$lib/services/chatUiActions.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { isGroupAdmin } from '$lib/services/chatAdminPolicy';
	import { openChatCall } from '$lib/services/chatCalls.svelte';
	import { unrecoveredDropHorizon } from '$lib/services/chatGroupMessages.svelte';
	import {
		chatGroupUnopenedCursor,
		classifyChatGroupUnopened
	} from '$lib/services/chatGroupRecovery';
	import {
		getChatGroup,
		isChatGroupRemoved,
		isChatGroupPoisoned,
		listChatGroupMembers
	} from '$lib/services/chatGroups.svelte';
	import { buildGroupSharePath } from '$lib/utils/groupShareLink';
	import { publicWebOrigin } from '$lib/utils/appOrigin';
	import { getChatGroupMuteLabel, isChatGroupMuted } from '$lib/services/chatGroupMutes.svelte';
	import BellOff from '@lucide/svelte/icons/bell-off';
	import Info from '@lucide/svelte/icons/info';
	import Share2 from '@lucide/svelte/icons/share-2';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import Phone from '@lucide/svelte/icons/phone';

	let {
		groupId,
		title = 'Cordn',
		titlePubkey
	}: {
		groupId?: string;
		title?: string;
		/** The person the title is named after (1:1 peer), for the petname mark. */
		titlePubkey?: string;
	} = $props();

	async function refreshAvailableKeyPackages() {
		if (!$activeAccount) return;
		await refreshInviteKeyPackagesAction(groupId);
	}

	let invitingRef = $state('');

	async function inviteMember(entry: AvailableKeyPackageWithCoordinator) {
		try {
			invitingRef = entry.kp_ref;
			await inviteGroupMemberAction(groupId, {
				identifier: entry.kp_ref,
				expectedStablePubkey: entry.pk
			});
		} finally {
			invitingRef = '';
		}
	}

	const group = $derived.by(() => (groupId ? getChatGroup(groupId) : undefined));
	const isRemoved = $derived.by(() => isChatGroupRemoved(group));
	const isPoisoned = $derived.by(() => isChatGroupPoisoned(group));
	const unopenedCursor = $derived.by(() => {
		if (!group) return undefined;
		return chatGroupUnopenedCursor({
			firstUnopenedCursor: group.firstUnopenedCursor,
			dropHorizon: unrecoveredDropHorizon(group),
			staleMarkCursor: group.staleMark?.cursor
		});
	});
	const unopenedVerdict = $derived.by(() =>
		classifyChatGroupUnopened({
			poisoned: isPoisoned,
			firstUnopenedCursor: unopenedCursor,
			durableFrontier: group?.firstUnopenedCursor,
			adoptedCursor: group?.appliedDocument?.cursor,
			stateBehind: group?.staleMark !== undefined || group?.skippedSiblingCommit !== undefined,
			lineCursor: group?.lineCursor
		})
	);
	const canInvite = $derived.by(() => {
		if (!$activeAccount || !group) return false;
		if (isRemoved) return false;
		return isGroupAdmin({ metadata: group.metadata, stablePubkey: $activeAccount.pubkey });
	});
	const inviteLabel = $derived.by(() =>
		canInvite ? 'Invite member' : 'Only configured group admins can invite members'
	);
	const infoHref = $derived.by(() =>
		groupId ? resolve('/chat/[id]/info', { id: groupRouteId(groupId) }) : '/chat'
	);
	let groupShareOpen = $state(false);

	const muted = $derived(groupId ? isChatGroupMuted(groupId) : false);
	const muteLabel = $derived(groupId ? getChatGroupMuteLabel(groupId) : '');

	const groupShareUrl = $derived.by(() => {
		if (!groupId || !group?.coordinatorKey) return '';
		const coordinator = getChatCoordinator(group.coordinatorKey);
		const metadata = group.metadata?.name
			? { name: group.metadata.name, icon: group.metadata.icon }
			: undefined;
		const path = buildGroupSharePath({
			groupId,
			coordinatorKey: group.coordinatorKey,
			relays: coordinator?.relays,
			metadata
		});
		return browser ? new URL(path, publicWebOrigin()).toString() : path;
	});

	const existingMemberPubkeys = $derived(
		groupId ? listChatGroupMembers(groupId).map((member) => member.stablePubkey) : []
	);

	async function navigateToInfo() {
		await goto(infoHref);
	}

	$effect(() => {
		if (chatHeaderActionsStore.inviteOpen) {
			void refreshAvailableKeyPackages();
		}
	});
</script>

<header
	class="border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80"
>
	<div class="flex items-start justify-between gap-3 px-4 py-3 sm:items-center md:px-6">
		<div class="flex min-w-0 flex-1 items-center gap-3 pr-2">
			<ChatMobileSidebarButton />

			{#if group}
				{#key group.id}
					<ChatGroupAvatar {group} class="h-10 w-10" />
				{/key}
			{:else}
				<Avatar class="h-10 w-10 border border-border bg-card p-1.5">
					<AvatarFallback class="bg-card text-base">
						<GroupAvatarFallback logoClass="h-full w-full" />
					</AvatarFallback>
				</Avatar>
			{/if}

			<button
				type="button"
				onclick={navigateToInfo}
				class="min-w-0 rounded-xl text-left transition-opacity outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				aria-label={`Open ${title} group info`}
			>
				<h1 class="flex min-w-0 items-center gap-1.5 text-lg font-semibold tracking-tight">
					<span class="truncate">{title}</span>
					<PetnameMark pubkey={titlePubkey} class="size-3.5" />
					{#if muted}
						<BellOff
							class="size-3.5 shrink-0 text-muted-foreground"
							aria-label={muteLabel}
							title={muteLabel}
						/>
					{/if}
				</h1>
			</button>
		</div>

		<ChatSearchBar {groupId} />

		{#if group && groupId}
			<Button
				variant="ghost"
				size="icon"
				class="size-10 rounded-xl border border-border text-muted-foreground hover:text-foreground"
				disabled={!$activeAccount || isRemoved || isPoisoned}
				title="Start or join an encrypted call"
				aria-label="Start or join an encrypted call"
				onclick={() => void openChatCall(groupId)}
			>
				<Phone />
			</Button>
		{/if}

		{#if group}
			<ChatGroupActions
				{group}
				{title}
				triggerClass="h-10 w-10 rounded-xl border border-border text-muted-foreground hover:text-foreground"
			>
				{#snippet headerActions()}
					<DropdownMenu.Item onclick={() => void navigateToInfo()} class="gap-2">
						<Info class="size-4" />
						<span>Group info</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item
						disabled={!$activeAccount || !canInvite}
						title={inviteLabel}
						onclick={() => (chatHeaderActionsStore.inviteOpen = true)}
						class="gap-2"
					>
						<UserPlus class="size-4" />
						<span>Invite member</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item
						disabled={!$activeAccount || !groupId}
						onclick={() => (groupShareOpen = true)}
						class="gap-2"
					>
						<Share2 class="size-4" />
						<span>Share group link</span>
					</DropdownMenu.Item>
				{/snippet}
			</ChatGroupActions>

			<Dialog.Root bind:open={chatHeaderActionsStore.inviteOpen}>
				<Dialog.Content class="sm:max-w-2xl">
					<Dialog.Header>
						<Dialog.Title>Invite member</Dialog.Title>
						<Dialog.Description>
							Invite someone who is reachable on this coordinator.
						</Dialog.Description>
					</Dialog.Header>

					{#if !canInvite}
						<p class="text-sm text-muted-foreground">
							Only configured group admins can invite members.
						</p>
					{/if}

					{#if chatHeaderActionsStore.error}
						<p class="text-sm text-destructive">{chatHeaderActionsStore.error}</p>
					{/if}

					<div class="space-y-3">
						<AvailableKeyPackageDirectory
							onStartChat={(entry) => inviteMember(entry)}
							startingRef={invitingRef}
							coordinatorKey={group?.coordinatorKey}
							excludePubkeys={existingMemberPubkeys}
							actionLabel="Invite"
							maxHeightClass="max-h-[26rem]"
							emptyMessage="No one else is reachable on this coordinator yet."
						/>
					</div>
				</Dialog.Content>
			</Dialog.Root>
		{/if}
	</div>

	{#if isRemoved}
		<p class="px-4 pb-3 text-sm text-muted-foreground md:px-6">
			This group is inactive for your account. Live watching and sending are disabled.
		</p>
	{:else if isPoisoned}
		<p class="px-4 pb-3 text-sm text-destructive md:px-6">
			This group's local state is corrupted. New messages cannot be decrypted. Contact a group admin
			to request a fresh invite.
		</p>
	{:else if group && unopenedVerdict && unopenedVerdict !== 'poisoned'}
		<p class="px-4 pb-3 text-sm text-amber-600 md:px-6 dark:text-amber-400">
			{unopenedVerdict === 'foreign-keys'
				? 'Some messages here use different group keys'
				: unopenedVerdict === 'catch-up'
					? 'Some earlier messages are still missing'
					: 'This device may be behind this group'}
			{#if (unopenedVerdict === 'behind' || unopenedVerdict === 'catch-up') && groupId}
				·
				<Button
					variant="link"
					size="xs"
					class="h-auto p-0 text-amber-600 dark:text-amber-400"
					disabled={chatGroupInfoActionsStore.repairSubmitting ||
						chatGroupInfoActionsStore.catchUpSubmitting}
					onclick={() =>
						void (unopenedVerdict === 'catch-up'
							? checkChatGroupMessagesAction(groupId)
							: repairChatGroupAction(groupId))}
				>
					{chatGroupInfoActionsStore.repairSubmitting &&
					chatGroupInfoActionsStore.repairGroupId === groupId
						? 'Repairing…'
						: chatGroupInfoActionsStore.catchUpSubmitting &&
							  chatGroupInfoActionsStore.catchUpGroupId === groupId
							? 'Recovering…'
							: unopenedVerdict === 'catch-up'
								? 'Recover messages'
								: 'Repair this chat'}
				</Button>
			{/if}
			·
			<a class="underline underline-offset-2" href={infoHref}>group details</a>
		</p>
	{/if}

	{#if $activeAccount && groupShareUrl}
		<QrShareDialog
			bind:open={groupShareOpen}
			title="Share group link"
			description="Share this group link as a QR code to invite others, or scan one to join."
			data={groupShareUrl}
			copyLabel="Copy group link"
			copiedLabel="Copied group link"
		/>
	{/if}
</header>
