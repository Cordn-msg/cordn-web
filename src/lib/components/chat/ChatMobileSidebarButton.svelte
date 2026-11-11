<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { hasUnreadChatAttention } from '$lib/services/chatAttention.svelte';
	import { getChatLayoutContext } from '$lib/components/chat/chatLayoutContext';
	import { activeGroupId } from '$lib/utils/groupShareLink';
	import { chatUpHref } from '$lib/utils/chatUpHref';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import PanelLeft from '@lucide/svelte/icons/panel-left';

	let {
		label = 'Open chats sidebar'
	}: {
		label?: string;
	} = $props();

	const { mobileSidebarOpen } = getChatLayoutContext();

	// Context-aware: on home this is the drawer toggle (group search, profile);
	// on every secondary screen it becomes the platform-standard back arrow —
	// one component, so all chat pages get back navigation for free.
	const isHome = $derived(page.url.pathname === resolve('/chat'));

	// Hierarchical back: the same "up one level" map the Android hardware back
	// button uses (chatUpHref), so the arrow and Back never disagree.
	const backHref = $derived(chatUpHref(page.url.pathname, page.url.search) ?? resolve('/chat'));

	// Inside a chat, the back dot signals unread attention in OTHER groups (and
	// welcomes/news): the open group is auto-marked read, so counting it would
	// leave a dot pinned on not-yet-viewed mentions forever.
	const openGroupId = $derived(activeGroupId(page.url.pathname));
</script>

{#snippet attentionDot()}
	<span
		class="absolute top-1.5 right-1.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background"
		aria-hidden="true"
	></span>
{/snippet}

{#if isHome}
	<Button
		type="button"
		variant="outline"
		size="icon"
		class="relative h-10 w-10 shrink-0 rounded-xl md:hidden"
		onclick={() => ($mobileSidebarOpen = true)}
		aria-label={label}
		title={label}
	>
		<PanelLeft class="size-4" />
		{#if hasUnreadChatAttention()}
			{@render attentionDot()}
		{/if}
	</Button>
{:else}
	<Button
		href={backHref}
		variant="outline"
		size="icon"
		class="relative h-10 w-10 shrink-0 rounded-xl"
		aria-label="Back"
		title="Back"
	>
		<ChevronLeft class="size-5" />
		{#if hasUnreadChatAttention(openGroupId)}
			{@render attentionDot()}
		{/if}
	</Button>
{/if}
