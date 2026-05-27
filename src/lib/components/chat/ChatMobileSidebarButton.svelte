<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { hasUnreadChatAttention } from '$lib/services/chatAttention.svelte';
	import { getChatLayoutContext } from '$lib/components/chat/chatLayoutContext';
	import PanelLeft from '@lucide/svelte/icons/panel-left';

	let {
		label = 'Open chats sidebar'
	}: {
		label?: string;
	} = $props();

	const { mobileSidebarOpen } = getChatLayoutContext();
</script>

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
