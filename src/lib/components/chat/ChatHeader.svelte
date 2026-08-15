<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import GroupAvatarFallback from './GroupAvatarFallback.svelte';
	import { Button } from '$lib/components/ui/button';
	import QrShareDialog from '$lib/components/QrShareDialog.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import AvailableKeyPackageDirectory from '$lib/components/chat/AvailableKeyPackageDirectory.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { resolve } from '$app/paths';
	import {
		chatHeaderActionsStore,
		inviteGroupMemberAction,
		refreshInviteKeyPackagesAction
	} from '$lib/services/chatUiActions.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { isGroupAdmin } from '$lib/services/chatAdminPolicy';
	import {
		getChatGroup,
		isChatGroupRemoved,
		isChatGroupPoisoned,
		listChatGroupMembers
	} from '$lib/services/chatGroups.svelte';
	import { buildGroupSharePath } from '$lib/utils/groupShareLink';
	import { publicWebOrigin } from '$lib/utils/appOrigin';
	import Info from '@lucide/svelte/icons/info';
	import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
	import Share2 from '@lucide/svelte/icons/share-2';
	import UserPlus from '@lucide/svelte/icons/user-plus';

	let {
		groupId,
		title = 'Cordn'
	}: {
		groupId?: string;
		title?: string;
	} = $props();

	async function refreshAvailableKeyPackages() {
		if (!$activeAccount) return;
		await refreshInviteKeyPackagesAction(groupId);
	}

	let invitingRef = $state('');

	async function inviteMember(keyPackageRef: string) {
		try {
			invitingRef = keyPackageRef;
			await inviteGroupMemberAction(groupId, keyPackageRef);
		} finally {
			invitingRef = '';
		}
	}

	const group = $derived.by(() => (groupId ? getChatGroup(groupId) : undefined));
	const isRemoved = $derived.by(() => isChatGroupRemoved(group));
	const isPoisoned = $derived.by(() => isChatGroupPoisoned(group));
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
				<h1 class="truncate text-lg font-semibold tracking-tight">{title}</h1>
			</button>
		</div>

		{#if groupId}
			<div class="hidden items-center gap-2 sm:flex">
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="h-10 w-10 rounded-xl"
					href={infoHref}
					aria-label="Group info"
					title="Group info"
				>
					<Info class="size-4" />
				</Button>
				<Dialog.Root bind:open={chatHeaderActionsStore.inviteOpen}>
					<Dialog.Trigger
						class="inline-flex"
						disabled={!$activeAccount || !canInvite}
						aria-label={inviteLabel}
					>
						<Button
							type="button"
							variant="outline"
							size="icon"
							class="h-10 w-10 rounded-xl"
							disabled={!$activeAccount || !canInvite}
							aria-label={inviteLabel}
							title={inviteLabel}
						>
							<UserPlus class="size-4" />
						</Button>
					</Dialog.Trigger>
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
								onStartChat={(entry) => inviteMember(entry.kp_ref)}
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

				<Button
					type="button"
					variant="outline"
					size="icon"
					class="h-10 w-10 rounded-xl"
					disabled={!$activeAccount || !groupId}
					aria-label="Share group link"
					title="Share group link"
					onclick={() => (groupShareOpen = true)}
				>
					<Share2 class="size-4" />
				</Button>
			</div>

			<div class="sm:hidden">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								type="button"
								variant="outline"
								size="icon"
								class="h-10 w-10 rounded-xl"
								aria-label="Open chat actions"
								title="Chat actions"
							>
								<MoreHorizontal class="size-4" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-56">
						<DropdownMenu.Item onclick={navigateToInfo} class="gap-2">
							<Info class="size-4" />
							<span>Group info</span>
						</DropdownMenu.Item>
						<DropdownMenu.Item
							disabled={!$activeAccount || !canInvite}
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
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
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
