<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import VirtualKeyPackageList from '$lib/components/chat/VirtualKeyPackageList.svelte';
	import { mergeProfileHint } from '$lib/components/chat/keyPackageProfileHints';
	import { matchesKeyPackageSearch } from '$lib/components/chat/keyPackageSearch';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { resolve } from '$app/paths';
	import {
		chatHeaderActionsStore,
		fetchGroupMessagesAction,
		inviteGroupMemberAction,
		refreshInviteKeyPackagesAction,
		toggleGroupWatchAction
	} from '$lib/services/chatUiActions.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '$lib/services/eventStore';
	import { isGroupAdmin } from '$lib/services/chatAdminPolicy';
	import { getChatGroup, isChatGroupRemoved } from '$lib/services/chatGroups.svelte';
	import { chatGroupWatchStore } from '$lib/services/chatGroupWatch.svelte';
	import Download from '@lucide/svelte/icons/download';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Info from '@lucide/svelte/icons/info';
	import Moon from '@lucide/svelte/icons/moon';
	import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
	import Sun from '@lucide/svelte/icons/sun';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { ProfileModel } from 'applesauce-core/models';
	import { setMode } from 'mode-watcher';
	import { Metadata } from 'nostr-tools/kinds';

	let {
		groupId,
		title = 'Cordn',
		subtitle = 'Coordinator-assisted messaging',
		icon,
		imageUrl
	}: {
		groupId?: string;
		title?: string;
		subtitle?: string;
		icon?: string;
		imageUrl?: string;
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
	let isDarkMode = $state(browser ? document.documentElement.classList.contains('dark') : false);
	let inviteKeyPackageSearch = $state('');
	let inviteKeyPackageProfileHints = $state<
		Record<string, { name?: string; displayName?: string; nip05?: string }>
	>({});
	let visibleInviteKeyPackageIds = $state<string[]>([]);

	const filteredInviteKeyPackages = $derived.by(() =>
		chatHeaderActionsStore.availableKeyPackages.filter((entry) =>
			matchesKeyPackageSearch({
				pubkey: entry.stablePubkey,
				keyPackageRef: entry.keyPackageRef,
				isLastResort: entry.isLastResort,
				profileHints: inviteKeyPackageProfileHints,
				search: inviteKeyPackageSearch
			})
		)
	);
	const visibleInviteKeyPackagePubkeys = $derived.by(() => {
		const visibleIds = new Set(visibleInviteKeyPackageIds);
		const pubkeys = new Set<string>();
		for (const entry of filteredInviteKeyPackages) {
			if (visibleIds.has(entry.keyPackageRef)) {
				pubkeys.add(entry.stablePubkey);
			}
		}
		return [...pubkeys];
	});
	const visibleInviteKeyPackageItems = $derived.by(() =>
		filteredInviteKeyPackages.map((entry) => ({
			id: entry.keyPackageRef,
			entry: { ...entry, label: formatKeyPackageLabel(entry) },
			pubkey: entry.stablePubkey,
			actionLabel: 'Invite',
			actionDisabled: chatHeaderActionsStore.inviteSubmitting,
			onAction: () => inviteMember(entry.keyPackageRef)
		}))
	);

	async function navigateToInfo() {
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(infoHref);
	}

	function toggleTheme() {
		const nextMode = isDarkMode ? 'light' : 'dark';
		setMode(nextMode);
		isDarkMode = nextMode === 'dark';
	}

	const themeLabel = $derived.by(() =>
		isDarkMode ? 'Switch to light theme' : 'Switch to dark theme'
	);

	$effect(() => {
		if (chatHeaderActionsStore.inviteOpen) {
			void refreshAvailableKeyPackages();
		}
	});

	$effect(() => {
		if (!chatHeaderActionsStore.inviteOpen) return;
		const uniquePubkeys = [...new Set(visibleInviteKeyPackagePubkeys)];
		if (uniquePubkeys.length === 0) return;
		const subscriptions = uniquePubkeys.flatMap((pubkey) => [
			addressLoader({
				kind: Metadata,
				pubkey,
				relays: metadataRelays
			}).subscribe(),
			eventStore.model(ProfileModel, pubkey).subscribe((profile) => {
				const next = {
					name: profile?.name,
					displayName: profile?.display_name,
					nip05: profile?.nip05
				};
				inviteKeyPackageProfileHints = mergeProfileHint(inviteKeyPackageProfileHints, pubkey, next);
			})
		]);

		return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
	});

	$effect(() => {
		if (!browser) return;

		const root = document.documentElement;
		const updateTheme = () => {
			isDarkMode = root.classList.contains('dark');
		};

		updateTheme();

		const observer = new MutationObserver(updateTheme);
		observer.observe(root, { attributes: true, attributeFilter: ['class'] });

		return () => observer.disconnect();
	});
</script>

<header
	class="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
>
	<div class="flex items-start justify-between gap-3 px-4 py-3 sm:items-center md:px-6">
		<div class="flex min-w-0 flex-1 items-center gap-3 pr-2">
			<ChatMobileSidebarButton />

			<Avatar class="h-10 w-10 border border-border bg-card">
				{#if imageUrl}
					<AvatarImage src={imageUrl} alt={title} class="object-cover" />
					<AvatarFallback class="bg-card text-base">
						{#if icon}
							{icon}
						{:else if title.length === 1}
							{title.slice(0, 1)}
						{:else}
							<img
								src="/cordn-logo-black.svg"
								alt="Cordn"
								class="h-full w-full object-contain dark:hidden"
							/>
							<img
								src="/cordn-logo.svg"
								alt="Cordn"
								class="hidden h-full w-full object-contain dark:block"
							/>
						{/if}
					</AvatarFallback>
				{:else if icon}
					<AvatarFallback class="bg-card text-base">{icon}</AvatarFallback>
				{:else}
					<AvatarFallback class="bg-card p-1.5 text-base">
						<img
							src="/cordn-logo-black.svg"
							alt="Cordn"
							class="h-full w-full object-contain dark:hidden"
						/>
						<img
							src="/cordn-logo.svg"
							alt="Cordn"
							class="hidden h-full w-full object-contain dark:block"
						/>
					</AvatarFallback>
				{/if}
			</Avatar>

			<div class="min-w-0">
				<h1 class="truncate text-lg font-semibold tracking-tight">{title}</h1>
				<p class="truncate text-sm text-muted-foreground">{subtitle}</p>
			</div>
		</div>

		{#if groupId}
			<div class="hidden items-center gap-2 sm:flex">
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="relative h-10 w-10 rounded-xl"
					aria-label={themeLabel}
					title={themeLabel}
					onclick={toggleTheme}
				>
					<Sun
						class="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 !transition-all dark:scale-0 dark:-rotate-90"
					/>
					<Moon
						class="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 !transition-all dark:scale-100 dark:rotate-0"
					/>
					<span class="sr-only">{themeLabel}</span>
				</Button>

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
									{filteredInviteKeyPackages.length} of {chatHeaderActionsStore.availableKeyPackages
										.length} available key package{chatHeaderActionsStore.availableKeyPackages
										.length === 1
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

							<Input
								bind:value={inviteKeyPackageSearch}
								placeholder="Search by pubkey, package reference, or last resort"
								aria-label="Search invite key packages"
							/>

							<div>
								{#if !$activeAccount}
									<p class="text-sm text-muted-foreground">Log in to invite members.</p>
								{:else if chatHeaderActionsStore.inviteLoading && chatHeaderActionsStore.availableKeyPackages.length === 0}
									<p class="text-sm text-muted-foreground">Loading available key packages…</p>
								{:else if chatHeaderActionsStore.availableKeyPackages.length === 0}
									<p class="text-sm text-muted-foreground">
										No coordinator key packages available for invitation.
									</p>
								{:else if filteredInviteKeyPackages.length === 0}
									<p class="text-sm text-muted-foreground">No key packages match your search.</p>
								{:else}
									<VirtualKeyPackageList
										items={visibleInviteKeyPackageItems}
										onVisibleItemsChange={(itemIds) => {
											visibleInviteKeyPackageIds = itemIds;
										}}
									/>
								{/if}
							</div>
						</div>
					</Dialog.Content>
				</Dialog.Root>
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
						<DropdownMenu.Item onclick={toggleTheme} class="gap-2">
							{#if isDarkMode}
								<Sun class="size-4" />
							{:else}
								<Moon class="size-4" />
							{/if}
							<span>{themeLabel}</span>
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={navigateToInfo} class="gap-2">
							<Info class="size-4" />
							<span>Group info</span>
						</DropdownMenu.Item>
						<DropdownMenu.Item
							disabled={!$activeAccount || chatHeaderActionsStore.watchLoading || isRemoved}
							onclick={toggleWatch}
							class="gap-2"
						>
							{#if isWatching}
								<EyeOff class="size-4" />
							{:else}
								<Eye class="size-4" />
							{/if}
							<span>{watchLabel}</span>
						</DropdownMenu.Item>
						{#if !isWatching}
							<DropdownMenu.Item
								disabled={!$activeAccount || chatHeaderActionsStore.fetchLoading || isRemoved}
								onclick={fetchMessages}
								class="gap-2"
							>
								<Download class="size-4" />
								<span>Fetch messages</span>
							</DropdownMenu.Item>
						{/if}
						<DropdownMenu.Item
							disabled={!$activeAccount || !canInvite}
							onclick={() => (chatHeaderActionsStore.inviteOpen = true)}
							class="gap-2"
						>
							<UserPlus class="size-4" />
							<span>Invite member</span>
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
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
