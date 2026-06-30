<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import ChatRichBody from '$lib/chat/ChatRichBody.svelte';
	import X from '@lucide/svelte/icons/x';
	import ExternalLink from '@lucide/svelte/icons/external-link';

	let {
		groupId,
		eventId,
		onClose,
		onNavigate,
		onJumpToMessage
	}: {
		groupId: string;
		eventId: string;
		onClose: () => void;
		onNavigate?: (eventId: string) => void;
		onJumpToMessage?: (eventId: string) => void;
	} = $props();

	const pageHref = $derived(resolve('/chat/[id]/e/[eventId]', { id: groupId, eventId }));
</script>

<div class="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
	<header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
		<h2 class="text-sm font-semibold tracking-tight">Message details</h2>
		<div class="flex items-center gap-1">
			<Button href={pageHref} variant="ghost" size="icon-sm" aria-label="Open as page">
				<ExternalLink class="size-4" />
			</Button>
			<Button variant="ghost" size="icon-sm" onclick={onClose} aria-label="Close details">
				<X class="size-4" />
			</Button>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<ChatRichBody {groupId} {eventId} {onNavigate} {onJumpToMessage} />
	</div>
</div>
