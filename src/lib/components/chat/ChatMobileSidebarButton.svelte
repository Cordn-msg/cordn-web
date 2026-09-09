<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { hasUnreadChatAttention } from '$lib/services/chatAttention.svelte';
	import { getChatLayoutContext } from '$lib/components/chat/chatLayoutContext';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { resolveGroupLocator } from '$lib/utils/groupShareLink';
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

	// Hierarchical back: a deterministic "up one level" link, independent of
	// how this page was entered. history.back() meant "wherever you came from"
	// — which exits to the home feed on cold-opened deep links and reloads.
	const backHref = $derived.by(() => {
		const routeId = page.route.id ?? '';
		if (routeId === '/chat/[id]/info') {
			const gid = page.params.id
				? resolveGroupLocator(page.params.id, page.url.searchParams).gid
				: undefined;
			return gid ? resolve('/chat/[id]', { id: groupRouteId(gid) }) : resolve('/chat');
		}
		if (routeId === '/chat/coordinators/[coordinatorKey]') return resolve('/chat/coordinators');
		// Coordinators lives outside /chat/config but its only entry is the
		// settings card, so "up" is settings (matches user expectation).
		if (routeId === '/chat/coordinators' || routeId.startsWith('/chat/config/')) {
			return resolve('/chat/config');
		}
		return resolve('/chat');
	});
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
		href={backHref}
		variant="outline"
		size="icon"
		class="h-10 w-10 shrink-0 rounded-xl"
		aria-label="Back"
		title="Back"
	>
		<ChevronLeft class="size-5" />
	</Button>
{/if}
