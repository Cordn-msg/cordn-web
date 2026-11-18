<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import ChatRichBody from '$lib/chat/ChatRichBody.svelte';
	import { Button } from '$lib/components/ui/button';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { chatUpHref } from '$lib/utils/chatUpHref';
	import { resolveGroupLocator } from '$lib/utils/groupShareLink';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	let { params } = $props();

	const groupId = $derived(resolveGroupLocator(params.id, page.url.searchParams).gid);
	const eventId = $derived(params.eventId);
	// Same hierarchy-driven map the Android Back button uses: a calendar-opened
	// event returns to the calendar, a chat-opened one to the chat feed.
	const fromCalendar = $derived(page.url.searchParams.get('from') === 'cal');
	const backHref = $derived(
		chatUpHref(page.url.pathname, page.url.search) ??
			resolve('/chat/[id]', { id: groupRouteId(groupId) })
	);
	const backLabel = $derived(fromCalendar ? 'Back to calendar' : 'Back to chat');

	function navigateToEvent(id: string) {
		// Keep the origin (and coordinator query) when following a link to a
		// sibling event, so Back still goes where the reader came from.
		const href =
			resolve('/chat/[id]/e/[eventId]', { id: groupRouteId(groupId), eventId: id }) +
			page.url.search;
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(href);
	}
</script>

<svelte:head>
	<meta name="description" content="Message detail view." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header
		class="flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6"
	>
		<!-- Deterministic back to this message's group (correct even for
		     cold-opened permalinks, where history.back would exit to home). -->
		<Button
			href={backHref}
			variant="outline"
			size="icon"
			class="h-10 w-10 shrink-0 rounded-xl"
			aria-label={backLabel}
			title={backLabel}
		>
			<ArrowLeft class="size-5" />
		</Button>
		<h1 class="truncate text-lg font-semibold tracking-tight">Message</h1>
	</header>

	<!-- pb-inset: conversation routes hide the tab bar, so this page must own the nav-bar
	     clearance itself (0px on web). -->
	<div class="min-h-0 flex-1 overflow-y-auto pb-inset">
		<div class="mx-auto w-full max-w-3xl">
			<ChatRichBody {groupId} {eventId} onNavigate={navigateToEvent} />
		</div>
	</div>
</div>
