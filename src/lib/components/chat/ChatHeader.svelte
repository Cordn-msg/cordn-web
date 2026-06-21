<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import QrShareDialog from '$lib/components/QrShareDialog.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import VirtualKeyPackageList from '$lib/components/chat/VirtualKeyPackageList.svelte';
	import { matchesKeyPackageSearch } from '$lib/components/chat/keyPackageSearch';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { resolve } from '$app/paths';
	import {
		chatHeaderActionsStore,
		inviteGroupMemberAction,
		refreshInviteKeyPackagesAction
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
	import { encodeGroupShareLink } from '$lib/utils/groupShareLink';
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
		title = 'Cordn'
	}: {
		groupId?: string;
		title?: string;
	} = $props();

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
		groupId ? resolve('/chat/[id]/info', { id: groupId }) : '/chat'
	);
	let isDarkMode = $state(browser ? document.documentElement.classList.contains('dark') : false);
	let groupShareOpen = $state(false);
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
	class="border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80"
>
	<div class="flex items-start justify-between gap-3 px-4 py-3 sm:items-center md:px-6">
		<div class="flex min-w-0 flex-1 items-center gap-3 pr-2">
			<ChatMobileSidebarButton />

			{#if group}
				<ChatGroupAvatar {group} class="h-10 w-10" />
			{:else}
				<Avatar class="h-10 w-10 border border-border bg-card p-1.5">
					<AvatarFallback class="bg-card text-base">
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
					class="relative h-10 w-10 rounded-xl"
					aria-label={themeLabel}
					title={themeLabel}
					onclick={toggleTheme}
				>
					<Sun
						class="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all! dark:scale-0 dark:-rotate-90"
					/>
					<Moon
						class="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all! dark:scale-100 dark:rotate-0"
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
