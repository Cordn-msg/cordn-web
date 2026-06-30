<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ChatRichBody from '$lib/chat/ChatRichBody.svelte';
	import { Button } from '$lib/components/ui/button';
	import { getChatGroup } from '$lib/services/chatGroups.svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	let { params } = $props();

	const groupId = $derived(params.id);
	const eventId = $derived(params.eventId);
	const group = $derived(getChatGroup(groupId));
	const backHref = $derived(resolve('/chat/[id]', { id: groupId }));

	function navigateToEvent(id: string) {
		void goto(resolve('/chat/[id]/e/[eventId]', { id: groupId, eventId: id }));
	}
</script>

<svelte:head>
	<title>Message | {group?.metadata?.name ?? 'Chat'} | Cordn</title>
	<meta name="description" content="Message detail view." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6">
		<ChatMobileSidebarButton />
		<Button href={backHref} variant="ghost" size="icon-sm" aria-label="Back to chat">
			<ArrowLeft class="size-4" />
		</Button>
		<h1 class="truncate text-sm font-semibold tracking-tight">Message</h1>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-3xl">
			<ChatRichBody {groupId} {eventId} onNavigate={navigateToEvent} />
		</div>
	</div>
</div>
