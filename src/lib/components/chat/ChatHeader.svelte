<script lang="ts">
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { resolve } from '$app/paths';
	import {
		chatHeaderActionsStore,
		fetchGroupMessagesAction,
		inviteGroupMemberAction,
		refreshInviteKeyPackagesAction,
		toggleGroupWatchAction
	} from '$lib/services/chatUiActions.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { isGroupAdmin } from '$lib/services/chatAdminPolicy';
	import { getChatGroup, isChatGroupRemoved } from '$lib/services/chatGroups.svelte';
	import { chatGroupWatchStore } from '$lib/services/chatGroupWatch.svelte';
	import Download from '@lucide/svelte/icons/download';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Info from '@lucide/svelte/icons/info';
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { resetMode, setMode } from 'mode-watcher';

	let {
		groupId,
		title = 'Cordn',
		subtitle = 'Coordinator-assisted messaging',
		icon
	}: {
		groupId?: string;
		title?: string;
		subtitle?: string;
		icon?: string;
	} = $props();

	async function fetchMessages() {
		await fetchGroupMessagesAction(groupId);
	}

	async function toggleWatch() {
		await toggleGroupWatchAction(groupId);
	}

	async function refreshAvailableKeyPackages() {
		if (!$activeAccount) return;
		await refreshInviteKeyPackagesAction(groupId);
	}

	async function inviteMember(identifier: string) {
		await inviteGroupMemberAction(groupId, identifier);
	}

	function formatKeyPackageLabel(
		entry: (typeof chatHeaderActionsStore.availableKeyPackages)[number]
	) {
		return `${entry.stablePubkey.slice(0, 12)}…${entry.stablePubkey.slice(-8)}`;
	}

	const isWatching = $derived.by(() =>
		groupId ? chatGroupWatchStore.watchingGroupIds.includes(groupId) : false
	);
	const group = $derived.by(() => (groupId ? getChatGroup(groupId) : undefined));
	const isRemoved = $derived.by(() => isChatGroupRemoved(group));
	const canInvite = $derived.by(() => {
		if (!$activeAccount || !group) return false;
		if (isRemoved) return false;
		return isGroupAdmin({ metadata: group.metadata, stablePubkey: $activeAccount.pubkey });
	});
	const watchLabel = $derived.by(() => (isWatching ? 'Stop watching group' : 'Watch group'));
	const inviteLabel = $derived.by(() =>
		canInvite ? 'Invite member' : 'Only configured group admins can invite members'
	);
	const infoHref = $derived.by(() =>
		groupId ? resolve('/chat/[id]/info', { id: groupId }) : '/chat'
	);

	$effect(() => {
		if (chatHeaderActionsStore.inviteOpen) {
			void refreshAvailableKeyPackages();
		}
	});
</script>

<header
	class="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
>
	<div class="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
		<div class="flex min-w-0 items-center gap-3">
			<Avatar class="h-10 w-10 border border-border bg-card">
				{#if icon}
					<AvatarFallback class="bg-card text-base">{icon}</AvatarFallback>
				{:else}
					<AvatarFallback class="bg-card text-base">🪢</AvatarFallback>
				{/if}
			</Avatar>

			<div class="min-w-0">
				<h1 class="truncate text-lg font-semibold tracking-tight">{title}</h1>
				<p class="truncate text-sm text-muted-foreground">{subtitle}</p>
			</div>
		</div>

		{#if groupId}
			<div class="flex items-center gap-2">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								type="button"
								variant="outline"
								size="icon"
								class="relative h-10 w-10 rounded-xl"
								aria-label="Toggle theme"
								title="Theme"
							>
								<Sun
									class="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 !transition-all dark:scale-0 dark:-rotate-90"
								/>
								<Moon
									class="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 !transition-all dark:scale-100 dark:rotate-0"
								/>
								<span class="sr-only">Toggle theme</span>
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end">
						<DropdownMenu.Item onclick={() => setMode('light')}>Light</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => setMode('dark')}>Dark</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => resetMode()}>System</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>

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

				<Button
					type="button"
					variant="outline"
					size="icon"
					class="h-10 w-10 rounded-xl"
					disabled={!$activeAccount || chatHeaderActionsStore.watchLoading || isRemoved}
					aria-label={watchLabel}
					title={watchLabel}
					onclick={toggleWatch}
				>
					{#if isWatching}
						<EyeOff class="size-4" />
					{:else}
						<Eye class="size-4" />
					{/if}
				</Button>

				{#if !isWatching}
					<Button
						type="button"
						variant="outline"
						size="icon"
						class="h-10 w-10 rounded-xl"
						disabled={!$activeAccount || chatHeaderActionsStore.fetchLoading || isRemoved}
						aria-label="Fetch messages"
						onclick={fetchMessages}
					>
						<Download class="size-4" />
					</Button>
				{/if}

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
								Consume a coordinator key package and publish a welcome for this group.
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
							<div class="flex items-center justify-between gap-2">
								<p class="text-sm text-muted-foreground">
									{chatHeaderActionsStore.availableKeyPackages.length} available key package{chatHeaderActionsStore
										.availableKeyPackages.length === 1
										? ''
										: 's'}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onclick={refreshAvailableKeyPackages}
									disabled={chatHeaderActionsStore.inviteLoading || !$activeAccount}
								>
									{chatHeaderActionsStore.inviteLoading ? 'Refreshing…' : 'Refresh'}
								</Button>
							</div>

							<div
								class="max-h-[24rem] space-y-2 overflow-y-auto rounded-xl border border-border p-3"
							>
								{#if !$activeAccount}
									<p class="text-sm text-muted-foreground">Log in to invite members.</p>
								{:else if chatHeaderActionsStore.inviteLoading && chatHeaderActionsStore.availableKeyPackages.length === 0}
									<p class="text-sm text-muted-foreground">Loading available key packages…</p>
								{:else if chatHeaderActionsStore.availableKeyPackages.length === 0}
									<p class="text-sm text-muted-foreground">
										No coordinator key packages available for invitation.
									</p>
								{:else}
									{#each chatHeaderActionsStore.availableKeyPackages as entry (entry.keyPackageRef)}
										<div
											class="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/60 px-4 py-3"
										>
											<div class="min-w-0 space-y-1">
												<p class="truncate font-medium">{formatKeyPackageLabel(entry)}</p>
												<p class="font-mono text-xs break-all text-muted-foreground">
													{entry.keyPackageRef}
												</p>
												<p class="text-xs text-muted-foreground">
													Published {new Date(
														entry.publishedAt
													).toLocaleString()}{entry.isLastResort ? ' · last resort' : ''}
												</p>
											</div>
											<Button
												type="button"
												size="sm"
												onclick={() => inviteMember(entry.keyPackageRef)}
												disabled={chatHeaderActionsStore.inviteSubmitting}
											>
												Invite
											</Button>
										</div>
									{/each}
								{/if}
							</div>
						</div>
					</Dialog.Content>
				</Dialog.Root>
			</div>
		{/if}
	</div>

	{#if chatGroupWatchStore.error}
		<p class="px-4 pb-3 text-sm text-destructive md:px-6">{chatGroupWatchStore.error}</p>
	{/if}
	{#if isRemoved}
		<p class="px-4 pb-3 text-sm text-muted-foreground md:px-6">
			This group is inactive for your account. Live watching and sending are disabled.
		</p>
	{/if}
</header>
