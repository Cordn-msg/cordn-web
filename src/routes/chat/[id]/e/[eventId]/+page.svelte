<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import ChatRichBody from '$lib/chat/ChatRichBody.svelte';
	import { Button } from '$lib/components/ui/button';
	import { getChatGroup } from '$lib/services/chatGroups.svelte';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { resolveGroupLocator } from '$lib/utils/groupShareLink';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	let { params } = $props();

	const groupId = $derived(resolveGroupLocator(params.id, page.url.searchParams).gid);
	const eventId = $derived(params.eventId);
	const group = $derived(groupId ? getChatGroup(groupId) : undefined);
	const backHref = $derived(resolve('/chat/[id]', { id: groupRouteId(groupId) }));

	function navigateToEvent(id: string) {
		void goto(resolve('/chat/[id]/e/[eventId]', { id: groupRouteId(groupId), eventId: id }));
	}
</script>

<svelte:head>
	<title>Message | {group?.metadata?.name ?? 'Chat'} | Cordn</title>
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
			aria-label="Back to chat"
		>
			<ArrowLeft class="size-5" />
		</Button>
		<h1 class="truncate text-lg font-semibold tracking-tight">Message</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-3xl">
			<ChatRichBody {groupId} {eventId} onNavigate={navigateToEvent} />
		</div>
	</div>
</div>
