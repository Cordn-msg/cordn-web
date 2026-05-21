<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import {
		getLatestChatGroupMessagePreview,
		getUnreadChatGroupMessageCount,
		pruneChatGroupPresence
	} from '$lib/services/chatGroupPresence.svelte';
	import { getChatGroup, listChatGroups } from '$lib/services/chatGroups.svelte';
	import {
		getCoordinatorColor,
		getChatCoordinator,
		listChatCoordinators
	} from '$lib/services/chatCoordinators.svelte';
	import {
		getUnreadWelcomeNotificationCount,
		listWelcomeNotifications,
		markAllWelcomeNotificationsRead,
		markWelcomeNotificationRead,
		chatWelcomeNotificationsStore
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import {
		acceptWelcomeAction,
		chatWelcomeActionsStore,
		refreshWelcomeNotificationsAction
	} from '$lib/services/chatUiActions.svelte';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import Bolt from '@lucide/svelte/icons/bolt';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Menu from '@lucide/svelte/icons/menu';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import type { Writable } from 'svelte/store';

	let {
		mobileSidebarOpen
	}: {
		mobileSidebarOpen: Writable<boolean>;
	} = $props();

	let collapsed = $state(false);
	let notificationsOpen = $state(false);
	const chats = $derived.by(() => listChatGroups());
	const coordinators = $derived.by(() => listChatCoordinators());
	const welcomeNotifications = $derived.by(() => listWelcomeNotifications());
	const unreadWelcomeNotifications = $derived.by(() => getUnreadWelcomeNotificationCount());
	const chatSummaries = $derived.by(() =>
		Object.fromEntries(
			chats.map((chat) => [
				chat.id,
				{
					preview: getLatestChatGroupMessagePreview(chat.id),
					unreadCount: getUnreadChatGroupMessageCount(chat.id)
				}
			])
		)
	);
	const groupedChats = $derived.by(() => {
		const groups = new Map<
			string,
			{ pubkey: string; label: string; color: string; chats: ReturnType<typeof listChatGroups> }
		>();

		for (const chat of chats) {
			const coordinator = getChatCoordinator(chat.coordinatorKey) ?? {
				pubkey: chat.coordinatorKey,
				label: `Coordinator ${chat.coordinatorKey.slice(0, 8)}`,
				color: undefined
			};

			const existing = groups.get(coordinator.pubkey);
			if (existing) {
				existing.chats.push(chat);
				continue;
			}

			groups.set(coordinator.pubkey, {
				pubkey: coordinator.pubkey,
				label: coordinator.label,
				color: getCoordinatorColor(coordinator),
				chats: [chat]
			});
		}

		return [...groups.values()].sort((a, b) => {
			const aIndex = coordinators.findIndex((entry) => entry.pubkey === a.pubkey);
			const bIndex = coordinators.findIndex((entry) => entry.pubkey === b.pubkey);
			return (
				(aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
				(bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex)
			);
		});
	});

	function isActive(href: string) {
		return page.url.pathname === href;
	}

	function getGroupHref(groupId: string) {
		return resolve('/chat/[id]', { id: groupId });
	}

	function getChatHomeHref() {
		return resolve('/chat');
	}

	function getCreateGroupHref() {
		return resolve('/chat/create-group');
	}

	function getConfigHref() {
		return resolve('/chat/config');
	}

	function getCoordinatorHref(pubkey: string) {
		return resolve('/chat/coordinators/[coordinatorKey]', { coordinatorKey: pubkey });
	}

	function getNotificationCoordinatorLabel(pubkey: string) {
		return getChatCoordinator(pubkey)?.label ?? `Coordinator ${pubkey.slice(0, 8)}`;
	}

	function getNotificationGroupLabel(groupId: string) {
		const group = getChatGroup(groupId);
		return group?.metadata?.name || group?.id || 'Joined group';
	}

	function getChatSummary(groupId: string) {
		return chatSummaries[groupId] ?? { preview: 'Group chat', unreadCount: 0 };
	}

	function closeMobileSidebar() {
		$mobileSidebarOpen = false;
	}

	async function refreshWelcomeNotifications() {
		if (!$activeAccount) return;
		await refreshWelcomeNotificationsAction();
	}

	async function acceptWelcome(notificationId: string) {
		if (!$activeAccount) return;
		const accepted = await acceptWelcomeAction(notificationId);
		if (accepted) {
			notificationsOpen = false;
		}
	}

	$effect(() => {
		const activePubkey = $activeAccount?.pubkey ?? '';
		if (!activePubkey || activePubkey === chatWelcomeActionsStore.lastFetchedAccountPubkey) return;
		chatWelcomeActionsStore.lastFetchedAccountPubkey = activePubkey;
		void refreshWelcomeNotifications();
	});

	$effect(() => {
		chats.length;
		pruneChatGroupPresence();
	});

	const sidebarClass = $derived(collapsed ? 'w-20 px-2.5' : 'w-72 px-3');
</script>

<button
	type="button"
	class="fixed top-4 left-4 z-40 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background/95 text-foreground shadow-sm backdrop-blur md:hidden"
	onclick={() => ($mobileSidebarOpen = true)}
	aria-label="Open chats sidebar"
>
	<Menu class="size-4" />
</button>

{#if $mobileSidebarOpen}
	<button
		type="button"
		class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
		onclick={closeMobileSidebar}
		aria-label="Close chats sidebar"
	></button>
{/if}

<aside
	class={`fixed inset-y-0 left-0 z-50 flex h-full w-[min(22rem,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-r border-border bg-card/95 py-3 shadow-xl backdrop-blur transition-[transform,width,padding] duration-200 md:static md:z-auto md:w-auto md:translate-x-0 md:bg-card/60 md:shadow-none ${$mobileSidebarOpen ? 'translate-x-0' : '-translate-x-[calc(100%+1rem)]'} ${sidebarClass}`}
>
	<div class={`flex items-center pb-4 ${collapsed ? 'justify-center' : 'justify-between gap-2'}`}>
		<a
			href={getChatHomeHref()}
			onclick={closeMobileSidebar}
			class={`flex min-w-0 items-center gap-3 rounded-xl transition-colors hover:text-foreground ${collapsed ? 'justify-center' : ''} ${isActive(getChatHomeHref()) ? 'text-foreground' : 'text-muted-foreground'}`}
			aria-label="Open chat home"
			title="Chat home"
		>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background p-1.5"
			>
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
			</div>

			{#if !collapsed}
				<div class="min-w-0">
					<p class="truncate text-sm font-semibold tracking-tight">Cordn</p>
					<p class="truncate text-xs text-muted-foreground">Chats</p>
				</div>
			{/if}
		</a>

		<div class="flex items-center gap-1">
			{#if !collapsed}
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="hidden h-9 w-9 shrink-0 rounded-lg md:inline-flex"
					onclick={() => (collapsed = !collapsed)}
				>
					<ChevronLeft class="size-4" />
				</Button>
			{/if}

			<Button
				type="button"
				variant="ghost"
				size="icon"
				class="h-9 w-9 shrink-0 rounded-lg md:hidden"
				onclick={closeMobileSidebar}
			>
				<X class="size-4" />
			</Button>
		</div>
	</div>

	{#if collapsed}
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="mb-4 hidden h-9 w-9 self-center rounded-lg md:inline-flex"
			onclick={() => (collapsed = !collapsed)}
		>
			<ChevronRight class="size-4" />
		</Button>
	{/if}

	<nav class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
		<a
			href={getCreateGroupHref()}
			onclick={closeMobileSidebar}
			class={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : ''} ${isActive('/chat/create-group') ? 'border-primary bg-primary/10 text-foreground' : 'border-dashed border-border text-muted-foreground hover:bg-background hover:text-foreground'}`}
		>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background"
			>
				<Plus class="size-4" />
			</div>

			{#if !collapsed}
				<div class="min-w-0">
					<p class="truncate font-medium">Create group</p>
					<p class="truncate text-xs text-muted-foreground">Start a new Cordn group</p>
				</div>
			{/if}
		</a>

		{#if chats.length === 0 && !collapsed}
			<div
				class="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
			>
				No groups yet. Create your first group.
			</div>
		{/if}

		{#each groupedChats as coordinatorGroup (coordinatorGroup.pubkey)}
			<div
				class={`space-y-2 border-l-4 pl-2 ${collapsed ? 'py-1' : 'rounded-r-xl border-y border-r border-border/60 bg-background/40 p-2 pl-2'}`}
				style={`border-left-color: ${coordinatorGroup.color};`}
			>
				<a
					href={getCoordinatorHref(coordinatorGroup.pubkey)}
					onclick={closeMobileSidebar}
					class={`flex items-center rounded-lg px-2 py-1.5 transition-colors ${collapsed ? 'justify-center' : 'hover:bg-background'} ${isActive(getCoordinatorHref(coordinatorGroup.pubkey)) ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
					aria-label={`Open ${coordinatorGroup.label}`}
					title={coordinatorGroup.label}
				>
					{#if collapsed}
						<span class="sr-only">{coordinatorGroup.label}</span>
						<span class="h-2.5 w-2.5 rounded-full border border-border/70 bg-background/80"></span>
					{:else}
						<p class="truncate text-xs font-semibold tracking-[0.18em] uppercase">
							{coordinatorGroup.label}
						</p>
					{/if}
				</a>

				<div class="space-y-1">
					{#each coordinatorGroup.chats as chat (chat.id)}
						{@const summary = getChatSummary(chat.id)}
						<a
							href={getGroupHref(chat.id)}
							onclick={closeMobileSidebar}
							class={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : 'ml-1'} ${isActive(getGroupHref(chat.id)) ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`}
						>
							<div class="relative shrink-0">
								<Avatar class="h-10 w-10 shrink-0 border border-border bg-background">
									{#if chat.metadata?.imageUrl}
										<AvatarImage
											src={chat.metadata.imageUrl}
											alt={chat.metadata?.name || chat.id}
											class="object-cover"
										/>
									{/if}
									<AvatarFallback class="bg-background text-sm font-medium"
										>{chat.metadata?.icon ||
											chat.metadata?.name?.slice(0, 1) ||
											'#'}</AvatarFallback
									>
								</Avatar>
								{#if summary.unreadCount > 0}
									<span
										class="absolute -top-1 -right-1 min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] leading-none font-semibold text-primary-foreground"
									>
										{summary.unreadCount}
									</span>
								{/if}
							</div>

							{#if !collapsed}
								<div class="min-w-0 flex-1">
									<div class="flex items-start justify-between gap-2">
										<p class="truncate font-medium">{chat.metadata?.name || chat.id}</p>
									</div>
									<p class="truncate text-xs text-muted-foreground">
										{summary.preview}
									</p>
								</div>
							{/if}
						</a>
					{/each}
				</div>
			</div>
		{/each}
	</nav>

	<div class="mt-auto flex flex-col gap-2 border-t border-border pt-4">
		<Dialog.Root bind:open={notificationsOpen}>
			<Dialog.Trigger
				class={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : ''} ${notificationsOpen ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`}
			>
				<div
					class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
				>
					<Inbox class="size-4" />
					{#if unreadWelcomeNotifications > 0}
						<span
							class="absolute -top-1 -right-1 min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] leading-none font-semibold text-primary-foreground"
						>
							{unreadWelcomeNotifications}
						</span>
					{/if}
				</div>

				{#if !collapsed}
					<div class="min-w-0 flex-1 text-left">
						<p class="truncate font-medium">Notifications</p>
						<p class="truncate text-xs text-muted-foreground">
							{unreadWelcomeNotifications > 0
								? `${unreadWelcomeNotifications} unread welcome${unreadWelcomeNotifications === 1 ? '' : 's'}`
								: 'No unread welcomes'}
						</p>
					</div>
				{/if}
			</Dialog.Trigger>

			<Dialog.Content class="sm:max-w-2xl">
				<Dialog.Header>
					<Dialog.Title>Welcome notifications</Dialog.Title>
					<Dialog.Description>
						Unified inbox for welcomes fetched across known coordinators.
					</Dialog.Description>
				</Dialog.Header>

				<div class="flex items-center justify-between gap-2">
					<p class="text-sm text-muted-foreground">
						{welcomeNotifications.length} welcome{welcomeNotifications.length === 1 ? '' : 's'} cached
					</p>
					<div class="flex gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onclick={markAllWelcomeNotificationsRead}
						>
							Mark all as read
						</Button>
						<Button
							type="button"
							size="sm"
							onclick={refreshWelcomeNotifications}
							disabled={chatWelcomeNotificationsStore.loading || !$activeAccount}
						>
							{chatWelcomeNotificationsStore.loading ? 'Refreshing…' : 'Refresh'}
						</Button>
					</div>
				</div>

				{#if chatWelcomeNotificationsStore.error}
					<p class="text-sm text-destructive">{chatWelcomeNotificationsStore.error}</p>
				{/if}

				<ScrollArea.Root class="mt-4 h-[26rem] rounded-xl border border-border">
					<div class="space-y-3 p-3">
						{#if !$activeAccount}
							<div
								class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
							>
								Log in to fetch welcomes.
							</div>
						{:else if welcomeNotifications.length === 0}
							<div
								class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
							>
								No welcomes fetched yet.
							</div>
						{:else}
							{#each welcomeNotifications as notification (notification.id)}
								<div
									class={`rounded-xl border px-4 py-3 ${notification.readAt ? 'border-border bg-background/50' : 'border-primary/40 bg-primary/5'}`}
								>
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0 space-y-1">
											<p class="font-medium">
												{getNotificationCoordinatorLabel(notification.coordinatorKey)}
											</p>
											<p class="font-mono text-xs break-all text-muted-foreground">
												{notification.kpRef}
											</p>
											<p class="text-xs text-muted-foreground">
												{new Date(notification.at).toLocaleString()}
											</p>
											{#if notification.acceptedGroupId}
												<p class="text-xs text-emerald-600 dark:text-emerald-400">
													Accepted into {getNotificationGroupLabel(notification.acceptedGroupId)}
												</p>
											{/if}
										</div>
										<div class="flex shrink-0 gap-2">
											{#if !notification.acceptedGroupId}
												<Button
													type="button"
													size="sm"
													onclick={() => acceptWelcome(notification.id)}
												>
													Accept
												</Button>
											{/if}
											{#if !notification.readAt}
												<Button
													type="button"
													variant="outline"
													size="sm"
													onclick={() => markWelcomeNotificationRead(notification.id)}
												>
													Mark read
												</Button>
											{/if}
											<Button
												href={getCoordinatorHref(notification.coordinatorKey)}
												variant="outline"
												size="sm"
											>
												Open coordinator
											</Button>
										</div>
									</div>
								</div>
							{/each}
						{/if}
					</div>
					<ScrollArea.Scrollbar orientation="vertical" />
				</ScrollArea.Root>
			</Dialog.Content>
		</Dialog.Root>

		<a
			href={getConfigHref()}
			onclick={closeMobileSidebar}
			class={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : ''} ${isActive('/chat/config') ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`}
		>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
			>
				<Bolt class="size-4" />
			</div>

			{#if !collapsed}
				<div class="min-w-0">
					<p class="truncate font-medium">Config</p>
					<p class="truncate text-xs text-muted-foreground">Preferences</p>
				</div>
			{/if}
		</a>

		<div
			class={`rounded-xl border border-border bg-background px-3 py-3 ${collapsed ? 'flex justify-center px-2' : ''}`}
		>
			{#if $activeAccount}
				<ProfileCard pubkey={$activeAccount.pubkey} showName={!collapsed} />
			{:else}
				<div class={collapsed ? 'flex justify-center' : 'w-full'}>
					<AccountLoginDialog />
				</div>
			{/if}
		</div>
	</div>
</aside>
