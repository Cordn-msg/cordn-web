<script lang="ts">
	import { onMount } from 'svelte';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import NewsFeedItem from '$lib/components/news/NewsFeedItem.svelte';
	import DonationDialog from '$lib/components/news/DonationDialog.svelte';
	import SupportersList from '$lib/components/news/SupportersList.svelte';
	import Megaphone from '@lucide/svelte/icons/megaphone';
	import { getNewsFeedItems, DEFAULT_DONATION, type DonationConfig } from '$lib/news/feedItems';
	import {
		isNewsItemUnread,
		loadNewsReadState,
		markNewsRead
	} from '$lib/news/newsReadState.svelte';

	const items = getNewsFeedItems();

	let donateOpen = $state(false);
	let donateConfig = $state<DonationConfig | undefined>(undefined);
	let scrollContainer: HTMLDivElement;

	// Hydrate before first paint so the "New" badges reflect stored read state.
	loadNewsReadState();

	function formatDayLabel(createdAt: number) {
		return new Date(createdAt).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'long',
			day: 'numeric'
		});
	}

	onMount(() => {
		// Feed sorts ascending (newest at the bottom, like chat). Land on the
		// newest unread release, or the bottom when everything is already read.
		const unreadItems = items.filter(isNewsItemUnread);
		const targetId = unreadItems.length ? unreadItems[unreadItems.length - 1].id : null;

		markNewsRead();

		if (targetId) {
			document.querySelector(`[data-news-id="${targetId}"]`)?.scrollIntoView({ block: 'start' });
		} else {
			scrollContainer.scrollTop = scrollContainer.scrollHeight;
		}
	});
</script>

<svelte:head>
	<title>News &amp; updates | Cordn</title>
	<meta name="description" content="Cordn release notes and product news." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header
		class="border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80"
	>
		<div class="flex items-center gap-3 px-4 py-3 md:px-6">
			<ChatMobileSidebarButton />
			<Avatar class="h-10 w-10 shrink-0 border border-border bg-card">
				<AvatarFallback class="bg-card">
					<Megaphone class="size-5" />
				</AvatarFallback>
			</Avatar>
			<div class="min-w-0">
				<h1 class="truncate text-lg font-semibold tracking-tight">News &amp; updates</h1>
				<p class="truncate text-xs text-muted-foreground">Release notes and product news</p>
			</div>
		</div>
	</header>

	<div bind:this={scrollContainer} class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-2xl px-3 py-6 sm:px-4 md:py-10">
			<div class="flex flex-col gap-4">
				{#each items as item, index (item.id)}
					{@const previousItem = items[index - 1]}
					{#if !previousItem || formatDayLabel(previousItem.createdAt) !== formatDayLabel(item.createdAt)}
						<p class="pt-2 text-center text-[11px] font-medium text-muted-foreground">
							{formatDayLabel(item.createdAt)}
						</p>
					{/if}
					<div data-news-id={item.id}>
						<NewsFeedItem
							{item}
							unread={isNewsItemUnread(item)}
							onDonate={(config) => {
								donateConfig = config;
								donateOpen = true;
							}}
						/>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<SupportersList config={DEFAULT_DONATION} />
</div>

<DonationDialog bind:open={donateOpen} config={donateConfig} />
