<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import QrCode from '$lib/components/QrCode.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import VirtualKeyPackageList from '$lib/components/chat/VirtualKeyPackageList.svelte';
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
	import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { isGroupAdmin } from '$lib/services/chatAdminPolicy';
	import {
		getChatGroup,
		isChatGroupRemoved,
		isChatGroupPoisoned,
		listChatGroupMembers
	} from '$lib/services/chatGroups.svelte';
	import { chatGroupWatchStore } from '$lib/services/chatGroupWatch.svelte';
	import { encodeGroupShareLink } from '$lib/utils/groupShareLink';
	import Download from '@lucide/svelte/icons/download';
	import Copy from '@lucide/svelte/icons/copy';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Info from '@lucide/svelte/icons/info';
	import Moon from '@lucide/svelte/icons/moon';
	import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Sun from '@lucide/svelte/icons/sun';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import { setMode } from 'mode-watcher';
	import { SvelteSet } from 'svelte/reactivity';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';

	let {
		groupId,
		title = 'Cordn',
		icon,
		imageUrl
	}: {
		groupId?: string;
		title?: string;
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
	const isPoisoned = $derived.by(() => isChatGroupPoisoned(group));
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
	let groupShareOpen = $state(false);
	let copiedGroupShareLink = $state(false);
	let inviteKeyPackageSearch = $state('');

	const groupShareUrl = $derived.by(() => {
		if (!groupId || !group?.coordinatorKey) return '';
		const coordinator = getChatCoordinator(group.coordinatorKey);
		const metadata = group.metadata?.name
			? { name: group.metadata.name, icon: group.metadata.icon }
			: undefined;
		const path = encodeGroupShareLink({
			groupId,
			coordinatorKey: group.coordinatorKey,
			relays: coordinator?.relays,
			metadata
		});
		return browser ? new URL(path, page.url).toString() : path;
	});

	async function copyGroupShareUrl() {
		if (!groupShareUrl || !browser) return;
		await navigator.clipboard.writeText(groupShareUrl);
		copiedGroupShareLink = true;
		setTimeout(() => {
			copiedGroupShareLink = false;
		}, 1500);
	}
	const inviteKeyPackageProfileHints = useProfileHints(
		() => {
			if (!chatHeaderActionsStore.inviteOpen) return [];
			return [...new Set(visibleInviteKeyPackagePubkeys)];
		},
		{ relays: metadataRelays }
	);
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
		const visibleIds = new SvelteSet(visibleInviteKeyPackageIds);
		const pubkeys = new SvelteSet<string>();
		for (const entry of filteredInviteKeyPackages) {
			if (visibleIds.has(entry.keyPackageRef)) {
				pubkeys.add(entry.stablePubkey);
			}
		}
		return [...pubkeys];
	});
	const visibleInviteKeyPackageItems = $derived.by(() => {
		const existingMemberPubkeys = new SvelteSet(
			groupId ? listChatGroupMembers(groupId).map((member) => member.stablePubkey) : []
		);

		return filteredInviteKeyPackages
			.filter((entry) => !existingMemberPubkeys.has(entry.stablePubkey))
			.map((entry) => ({
				id: entry.keyPackageRef,
				entry: { ...entry, label: formatKeyPackageLabel(entry) },
				pubkey: entry.stablePubkey,
				actionLabel: 'Invite',
				actionDisabled: chatHeaderActionsStore.inviteSubmitting,
				onAction: () => inviteMember(entry.keyPackageRef)
			}));
	});

	async function navigateToInfo() {
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
									{#if chatHeaderActionsStore.inviteLoading}
										<Spinner class="mr-1 size-3" />
									{/if}
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
		<Dialog.Root bind:open={groupShareOpen}>
			<Dialog.Content class="sm:max-w-md">
				<Dialog.Header>
					<Dialog.Title>Share group link</Dialog.Title>
					<Dialog.Description
						>Share this group link as a QR code to invite others.</Dialog.Description
					>
				</Dialog.Header>

				<div class="flex flex-col items-center gap-4 py-2">
					<QrCode data={groupShareUrl} size={220} />
					<p
						class="w-full rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs break-all text-muted-foreground"
					>
						{groupShareUrl}
					</p>
					<Button type="button" variant="outline" class="w-full" onclick={copyGroupShareUrl}>
						<Copy class="mr-2 size-4" />
						{copiedGroupShareLink ? 'Copied group link' : 'Copy group link'}
					</Button>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	{/if}
</header>
