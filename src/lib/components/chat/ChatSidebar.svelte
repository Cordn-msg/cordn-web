<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteMap } from 'svelte/reactivity';
	import ChatGroupListItem from '$lib/components/chat/ChatGroupListItem.svelte';
	import ChatActionIcons from '$lib/components/chat/ChatActionIcons.svelte';
	import * as InputGroup from '$lib/components/ui/input-group';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import {
		getLatestChatGroupMessagePreview,
		getUnreadChatGroupReferenceCount,
		getUnreadChatGroupMessageCount,
		pruneChatGroupPresence
	} from '$lib/services/chatGroupPresence.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import {
		getCoordinatorColor,
		getChatCoordinator,
		listChatCoordinators
	} from '$lib/services/chatCoordinators.svelte';
	import { searchChatMessages } from '$lib/services/chatMessageSearch';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getCoordinatorReconnectTone } from '$lib/services/chatReconnectStatus.svelte';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import type { Writable } from 'svelte/store';

	let {
		mobileSidebarOpen
	}: {
		mobileSidebarOpen: Writable<boolean>;
	} = $props();

	let collapsed = $state(false);
	let searchQuery = $state('');
	let debouncedSearchQuery = $state('');
	const chats = $derived.by(() =>
		[...listChatGroups()].sort((a, b) => {
			const aLatest = Math.max(a.createdAt, a.messages.at(-1)?.createdAt ?? 0);
			const bLatest = Math.max(b.createdAt, b.messages.at(-1)?.createdAt ?? 0);
			return bLatest - aLatest;
		})
	);
	const coordinators = $derived.by(() => listChatCoordinators());
	const searchResults = $derived.by(() =>
		searchChatMessages(debouncedSearchQuery, {
			limit: 50,
			activePubkey: $activeAccount?.pubkey
		})
	);
	const isSearching = $derived(debouncedSearchQuery.trim().length >= 2);
	const chatSummaries = $derived.by(() =>
		Object.fromEntries(
			chats.map((chat) => [
				chat.id,
				{
					preview: getLatestChatGroupMessagePreview(chat.id),
					unreadCount: getUnreadChatGroupMessageCount(chat.id),
					unreadReferenceCount: $activeAccount?.pubkey
						? getUnreadChatGroupReferenceCount(chat.id, $activeAccount.pubkey)
						: 0
				}
			])
		)
	);
	const groupedChats = $derived.by(() => {
		const groups = new SvelteMap<
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

	async function navigateToMessage(groupId: string, messageKey: string) {
		closeMobileSidebar();
		const groupHref = resolve('/chat/[id]', { id: groupId });
		const targetUrl = new URL(groupHref, page.url);
		targetUrl.searchParams.set('message', messageKey);
		// The path is resolved above before adding a local query parameter.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(`${groupHref}?${targetUrl.searchParams.toString()}`);
	}

	function getChatHomeHref() {
		return resolve('/chat');
	}

	function getCreateGroupHref() {
		return resolve('/chat/create-group');
	}

	function getCoordinatorHref(pubkey: string) {
		return resolve('/chat/coordinators/[coordinatorKey]', { coordinatorKey: pubkey });
	}

	function getChatSummary(groupId: string) {
		return (
			chatSummaries[groupId] ?? { preview: 'Group chat', unreadCount: 0, unreadReferenceCount: 0 }
		);
	}

	function closeMobileSidebar() {
		$mobileSidebarOpen = false;
	}

	function formatSearchResultTime(createdAt: number) {
		return new Date(createdAt).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function getCoordinatorStatusClass(coordinatorKey: string) {
		const tone = getCoordinatorReconnectTone(coordinatorKey);
		if (tone === 'error') {
			return 'bg-destructive';
		}

		if (tone === 'active') {
			return 'bg-amber-500';
		}

		const hasChats = groupedChats.some((entry) => entry.pubkey === coordinatorKey);
		return hasChats ? 'bg-emerald-500' : 'bg-muted-foreground/40';
	}

	$effect(() => {
		void chats.length;
		pruneChatGroupPresence();
	});

	$effect(() => {
		const nextQuery = searchQuery;
		const timer = setTimeout(() => {
			debouncedSearchQuery = nextQuery;
		}, 200);

		return () => clearTimeout(timer);
	});

	const sidebarClass = $derived(collapsed ? 'md:w-20 px-2.5' : 'md:w-72 px-3');
</script>

{#if $mobileSidebarOpen}
	<button
		type="button"
		class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
		onclick={closeMobileSidebar}
		aria-label="Close chats sidebar"
	></button>
{/if}

<aside
	class={`fixed inset-y-0 left-0 z-50 flex h-full w-[min(22rem,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-r border-border bg-card/95 py-3 shadow-xl backdrop-blur transition-[transform,width,padding] duration-200 md:static md:z-auto md:translate-x-0 md:bg-card/60 md:shadow-none ${$mobileSidebarOpen ? 'translate-x-0' : '-translate-x-[calc(100%+1rem)]'} ${sidebarClass}`}
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

	{#if !collapsed}
		<div class="pb-3">
			<InputGroup.Root>
				<InputGroup.Input
					bind:value={searchQuery}
					type="search"
					placeholder="Search messages..."
					aria-label="Search messages"
				/>
				<InputGroup.Addon>
					<Search class="size-4" />
				</InputGroup.Addon>
				{#if isSearching}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text>{searchResults.length} results</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>
		</div>
	{/if}

	<nav class="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto pb-4">
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

		{#if isSearching && !collapsed}
			<div class="space-y-2">
				<div class="flex items-center justify-between px-1">
					<p class="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
						Search results
					</p>
					<p class="text-xs text-muted-foreground">Max 50</p>
				</div>

				{#if searchResults.length === 0}
					<div
						class="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
					>
						No messages found for “{debouncedSearchQuery.trim()}”.
					</div>
				{:else}
					<div class="space-y-1">
						{#each searchResults as result (result.messageKey)}
							<button
								type="button"
								onclick={() => navigateToMessage(result.groupId, result.messageKey)}
								class="block rounded-xl border border-transparent px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
							>
								<div class="flex items-start justify-between gap-2">
									<p class="truncate font-medium text-foreground">{result.groupTitle}</p>
									<p class="shrink-0 text-[10px] text-muted-foreground">
										{formatSearchResultTime(result.createdAt)}
									</p>
								</div>
								<p class="mt-1 line-clamp-2 text-xs leading-5">{result.snippet}</p>
								<p class="mt-1 truncate text-[10px] text-muted-foreground">
									{result.sender.slice(0, 12)}…
								</p>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{:else if chats.length === 0 && !collapsed}
			<div
				class="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
			>
				No groups yet. Create your first group.
			</div>
		{:else}
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
							<span class="h-2.5 w-2.5 rounded-full border border-border/70 bg-background/80"
							></span>
						{:else}
							<div class="flex min-w-0 items-center gap-2">
								<span
									class={`h-2 w-2 shrink-0 rounded-full ${getCoordinatorStatusClass(coordinatorGroup.pubkey)}`}
								></span>
								<p class="truncate text-xs font-semibold tracking-[0.18em] uppercase">
									{coordinatorGroup.label}
								</p>
							</div>
						{/if}
					</a>

					<div class="space-y-1">
						{#each coordinatorGroup.chats as chat (chat.id)}
							{@const summary = getChatSummary(chat.id)}
							<ChatGroupListItem
								group={chat}
								href={getGroupHref(chat.id)}
								preview={summary.preview}
								unreadCount={summary.unreadCount}
								unreadReferenceCount={summary.unreadReferenceCount}
								{collapsed}
								variant="sidebar"
								active={isActive(getGroupHref(chat.id))}
								onclick={closeMobileSidebar}
							/>
						{/each}
					</div>
				</div>
			{/each}
		{/if}
	</nav>

	<div class="mt-auto flex flex-col gap-2 border-t border-border pt-4">
		<ChatActionIcons {collapsed} onNavigate={closeMobileSidebar} />

		{#if $activeAccount}
			<div
				class={`rounded-xl border border-border bg-background px-3 py-3 transition-colors ${collapsed ? 'flex justify-center overflow-hidden px-2' : 'block'} ${isActive('/chat/config') ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}`}
			>
				<ProfileCard
					pubkey={$activeAccount.pubkey}
					showName={!collapsed}
					showLogout={!collapsed}
					logoutButtonVariant="destructive"
				/>
			</div>
		{:else}
			<div
				class={`rounded-xl border border-border bg-background px-3 py-3 ${collapsed ? 'flex justify-center px-2' : ''}`}
			>
				<div class={collapsed ? 'flex justify-center' : 'w-full'}>
					<AccountLoginDialog />
				</div>
			</div>
		{/if}
	</div>
</aside>
