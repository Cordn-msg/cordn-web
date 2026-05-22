<script lang="ts">
	import { Button } from '$lib/components/ui/button';
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
	class="h-10 w-10 shrink-0 rounded-xl md:hidden"
	onclick={() => ($mobileSidebarOpen = true)}
	aria-label={label}
	title={label}
>
	<PanelLeft class="size-4" />
</Button>
