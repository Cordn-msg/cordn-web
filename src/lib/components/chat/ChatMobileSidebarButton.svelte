<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { hasUnreadChatAttention } from '$lib/services/chatAttention.svelte';
	import { getChatLayoutContext } from '$lib/components/chat/chatLayoutContext';
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

	function handleBack() {
		// SvelteKit tags its history entries with an index; a cold-opened deep
		// link has none, so fall back to an explicit jump home.
		if (history.state?.index > 0) history.back();
		else void goto(resolve('/chat'));
	}
</script>

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
			<span
				class="absolute top-1.5 right-1.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background"
				aria-hidden="true"
			></span>
		{/if}
	</Button>
{:else}
	<Button
		type="button"
		variant="outline"
		size="icon"
		class="h-10 w-10 shrink-0 rounded-xl md:hidden"
		onclick={handleBack}
		aria-label="Back"
		title="Back"
	>
		<ChevronLeft class="size-5" />
	</Button>
{/if}
