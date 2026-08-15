<script lang="ts">
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { eventStore } from '$lib/services/eventStore';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { ProfileModel } from 'applesauce-core/models';
	import { Metadata } from 'nostr-tools/kinds';
	import ChatGroupAvatar from '$lib/components/chat/ChatGroupAvatar.svelte';
	import ChatGroupListItem from '$lib/components/chat/ChatGroupListItem.svelte';
	import ChatActionIcons from '$lib/components/chat/ChatActionIcons.svelte';
	import QuickActions from '$lib/components/chat/QuickActions.svelte';
	import * as InputGroup from '$lib/components/ui/input-group';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { getChatGroupSummary } from '$lib/services/chatGroupPresence.svelte';
	import { listChatGroupMembers, listChatGroups } from '$lib/services/chatGroups.svelte';
	import { normalizePubKey } from '$lib/utils';
	import { activeGroupId } from '$lib/utils/groupShareLink';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { getGroupActivityAt } from '$lib/components/chat/chatGroupDisplay';
	import { searchChatMessages } from '$lib/services/chatMessageSearch';
	import NewsListItem from '$lib/components/news/NewsListItem.svelte';
	import { getUnreadNewsCount } from '$lib/news/newsReadState.svelte';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import {
		getSearchKeywords,
		resolveSearchQuery,
		type SearchKeyword
	} from '$lib/services/chatSearchKeywords';
	import type { Writable } from 'svelte/store';

	let {
		mobileSidebarOpen
	}: {
		mobileSidebarOpen: Writable<boolean>;
	} = $props();

	const SIDEBAR_COLLAPSED_KEY = 'cordn.chatSidebarCollapsed';
	let collapsed = $state(browser ? localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' : false);
	let searchQuery = $state('');
	let debouncedSearchQuery = $state('');
	let searchInputRef: HTMLInputElement | null = $state(null);
	let keywordStart = $state(-1);
	let keywordQuery = $state('');
	let highlightedKeywordIndex = $state(0);
	let profileNames: string[] = $state([]);
	const groupProfileHints = useProfileHints(
		() => {
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			return [
				...new Set(
					chats.flatMap((chat) =>
						listChatGroupMembers(chat.id)
							.map((member) => normalizePubKey(member.stablePubkey))
							.filter((pubkey): pubkey is string => Boolean(pubkey) && pubkey !== activePubkey)
					)
				)
			];
		},
		{ relays: metadataRelays }
	);
	const allChats = $derived.by(() => listChatGroups());
	const newsUnreadCount = $derived.by(() => getUnreadNewsCount());
	const resolvedSearchQuery = $derived.by(() =>
		resolveSearchQuery(debouncedSearchQuery, $activeAccount?.pubkey, profileNames)
	);
	const searchResults = $derived.by(() =>
		searchChatMessages(resolvedSearchQuery, {
			limit: 50,
			activePubkey: $activeAccount?.pubkey,
			profileHints: groupProfileHints
		})
	);
	const isSearching = $derived(debouncedSearchQuery.trim().length >= 2);
	const activeKeyword = $derived(keywordStart >= 0);
	const keywordMatches = $derived.by(() => {
		if (!activeKeyword) return [];
		const query = keywordQuery.toLowerCase();
		const keywords = getSearchKeywords();
		if (!query) return keywords;
		return keywords.filter((k) => k.label.toLowerCase().includes(query));
	});
	const chatSummaries = $derived.by(() =>
		Object.fromEntries(
			allChats.map((chat) => [chat.id, getChatGroupSummary(chat.id, $activeAccount?.pubkey)])
		)
	);

	function hasUnreadActivity(groupId: string): boolean {
		const summary = chatSummaries[groupId];
		return Boolean(summary && (summary.unreadCount > 0 || summary.unreadReferenceCount > 0));
	}

	// Same rule as the home feed: unread chats bubble to the top (newest first
	// within the tier), read chats settle by last activity.
	const chats = $derived.by(() =>
		[...allChats].sort(
			(a, b) =>
				Number(hasUnreadActivity(b.id)) - Number(hasUnreadActivity(a.id)) ||
				getGroupActivityAt(b) - getGroupActivityAt(a)
		)
	);
	function isActive(href: string) {
		return page.url.pathname === href;
	}

	// gid-based: the [id] segment may be a cordn1 ref or a bare gid, so compare the
	// decoded gid instead of a raw path string (cordn1 URLs would break isActive).
	// Decoded once per URL change (isGroupActive runs per row), not per row.
	const activeGroupGid = $derived(activeGroupId(page.url.pathname, page.url.searchParams));
	function isGroupActive(groupId: string) {
		return activeGroupGid === groupId;
	}

	async function navigateToMessage(groupId: string, messageKey: string) {
		closeMobileSidebar();
		const groupHref = resolve('/chat/[id]', { id: groupRouteId(groupId) });
		const targetUrl = new URL(groupHref, page.url);
		targetUrl.searchParams.set('message', messageKey);
		// The path is resolved above before adding a local query parameter.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(`${groupHref}?${targetUrl.searchParams.toString()}`);
	}

	function getChatHomeHref() {
		return resolve('/chat');
	}

	function getChatSummary(groupId: string) {
		return (
			chatSummaries[groupId] ?? { preview: 'Group chat', unreadCount: 0, unreadReferenceCount: 0 }
		);
	}

	function closeMobileSidebar() {
		$mobileSidebarOpen = false;
	}

	function getGroupById(groupId: string) {
		return chats.find((chat) => chat.id === groupId);
	}

	function formatSearchResultTime(createdAt: number) {
		return new Date(createdAt).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function handleSearchInput(event: Event) {
		updateKeywordState(event.currentTarget as HTMLInputElement);
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (activeKeyword && keywordMatches.length > 0) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				highlightedKeywordIndex = (highlightedKeywordIndex + 1) % keywordMatches.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				highlightedKeywordIndex =
					(highlightedKeywordIndex - 1 + keywordMatches.length) % keywordMatches.length;
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				selectKeyword(keywordMatches[highlightedKeywordIndex]);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				closeKeywordDropdown();
				return;
			}
		}
	}

	function updateKeywordState(target: HTMLInputElement) {
		const caret = target.selectionStart ?? 0;
		const beforeCaret = searchQuery.slice(0, caret);
		const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret);
		if (!match) {
			closeKeywordDropdown();
			return;
		}
		keywordStart = beforeCaret.length - match[2].length - 1;
		keywordQuery = match[2];
		highlightedKeywordIndex = 0;
	}

	function closeKeywordDropdown() {
		keywordStart = -1;
		keywordQuery = '';
		highlightedKeywordIndex = 0;
	}

	function selectKeyword(keyword: SearchKeyword) {
		if (keywordStart < 0) return;
		const before = searchQuery.slice(0, keywordStart);
		const after = searchQuery.slice(keywordStart + 1 + keywordQuery.length);
		searchQuery = `${before}@${keyword.trigger} ${after}`;
		closeKeywordDropdown();
		requestAnimationFrame(() => searchInputRef?.focus());
	}

	$effect(() => {
		const pubkey = $activeAccount?.pubkey;
		if (!pubkey) {
			profileNames = [];
			return;
		}

		const loader = addressLoader({
			kind: Metadata,
			pubkey,
			relays: metadataRelays
		}).subscribe();

		const sub = eventStore.model(ProfileModel, pubkey).subscribe((profile) => {
			const next: string[] = [];
			if (profile?.name) next.push(profile.name);
			if (profile?.display_name && profile.display_name !== profile?.name) {
				next.push(profile.display_name);
			}
			if (profile?.nip05) next.push(profile.nip05);

			const current = untrack(() => profileNames);
			if (current.length === next.length && current.every((name, index) => name === next[index])) {
				return;
			}

			profileNames = next;
		});

		return () => {
			loader.unsubscribe();
			sub.unsubscribe();
		};
	});

	$effect(() => {
		const nextQuery = searchQuery;
		const timer = setTimeout(() => {
			debouncedSearchQuery = nextQuery;
		}, 200);

		return () => clearTimeout(timer);
	});

	$effect(() => {
		const value = collapsed;
		if (browser) {
			localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? '1' : '0');
		}
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
	class={`fixed inset-y-0 left-0 z-50 flex h-full w-[min(22rem,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-r border-border bg-card/95 pt-safe pb-safe shadow-xl backdrop-blur transition-[transform,width,padding] duration-200 md:static md:z-auto md:translate-x-0 md:bg-card/60 md:shadow-none ${$mobileSidebarOpen ? 'translate-x-0' : '-translate-x-[calc(100%+1rem)]'} ${sidebarClass}`}
>
	<div class={`flex items-center pb-4 ${collapsed ? 'justify-center' : 'justify-between gap-2'}`}>
		<a
			href={getChatHomeHref()}
			onclick={closeMobileSidebar}
			class={`flex min-w-0 items-center gap-3 rounded-xl transition-colors hover:text-foreground ${collapsed ? 'justify-center' : ''} ${isActive(getChatHomeHref()) ? 'text-foreground' : 'text-muted-foreground'}`}
			aria-label="Open chats"
			title="Chats"
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

	{#if !collapsed && chats.length > 0}
		<div class="pb-3">
			<InputGroup.Root>
				<InputGroup.Input
					bind:ref={searchInputRef}
					bind:value={searchQuery}
					type="search"
					placeholder="Search messages…"
					aria-label="Search messages"
					oninput={handleSearchInput}
					onkeydown={handleSearchKeydown}
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
			{#if activeKeyword && keywordMatches.length > 0}
				<div class="relative">
					<div
						class="absolute inset-x-0 top-0 z-10 rounded-xl border border-border bg-popover p-1 shadow-lg"
					>
						{#each keywordMatches as keyword, index (keyword.trigger)}
							<button
								type="button"
								class={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${index === highlightedKeywordIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`}
								onclick={() => selectKeyword(keyword)}
								tabindex="-1"
							>
								<div class="min-w-0 flex-1">
									<p class="truncate font-medium">@{keyword.label}</p>
									<p class="truncate text-xs text-muted-foreground">
										{keyword.description}
									</p>
								</div>
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<nav
		class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto pb-4"
	>
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
							{@const group = getGroupById(result.groupId)}
							<button
								type="button"
								onclick={() => navigateToMessage(result.groupId, result.messageKey)}
								class="block w-full rounded-xl border border-transparent px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
							>
								<div class="flex items-start justify-between gap-2">
									<div class="flex min-w-0 items-center gap-2">
										{#if group}
											<ChatGroupAvatar
												{group}
												class="h-5 w-5 shrink-0"
												fallbackClass="text-[9px] font-medium"
											/>
										{/if}
										<p class="truncate font-medium text-foreground">{result.groupTitle}</p>
									</div>
									<p class="shrink-0 text-[10px] text-muted-foreground">
										{formatSearchResultTime(result.createdAt)}
									</p>
								</div>
								<p class="mt-1 line-clamp-2 text-xs leading-5">{result.snippet}</p>
								<div class="mt-1 min-w-0 truncate">
									<ProfileCard
										pubkey={result.sender}
										mode="inline"
										showInlineAvatar={true}
										profileLink={false}
									/>
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{:else if chats.length === 0 && !collapsed}
			<div
				class="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
			>
				No chats yet. Start a new conversation.
			</div>
		{:else}
			<div class="space-y-1">
				{#each chats as chat (chat.id)}
					{@const summary = getChatSummary(chat.id)}
					<ChatGroupListItem
						group={chat}
						href={resolve('/chat/[id]', { id: groupRouteId(chat.id) })}
						preview={summary.preview}
						unreadCount={summary.unreadCount}
						unreadReferenceCount={summary.unreadReferenceCount}
						{collapsed}
						variant="sidebar"
						active={isGroupActive(chat.id)}
						onclick={closeMobileSidebar}
						profileHints={groupProfileHints}
					/>
				{/each}
			</div>
		{/if}
		{#if !(isSearching && !collapsed)}
			<NewsListItem
				href={resolve('/chat/news')}
				variant="sidebar"
				{collapsed}
				unreadCount={newsUnreadCount}
				active={isActive(resolve('/chat/news'))}
				onclick={closeMobileSidebar}
			/>
		{/if}
	</nav>

	<div class="mt-auto flex flex-col gap-2 border-t border-border pt-4">
		{#if $activeAccount}
			{#if collapsed}
				<ChatActionIcons {collapsed} onNavigate={closeMobileSidebar} />
			{:else}
				<QuickActions storageKey="cordn.sidebarQuickActionsOpen" onNavigate={closeMobileSidebar} />
			{/if}
		{/if}

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
