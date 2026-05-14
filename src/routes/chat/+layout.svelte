<script lang="ts">
	import ChatSidebar from '$lib/components/chat/ChatSidebar.svelte';

	let { children } = $props();
</script>

<div class="flex h-screen min-h-screen bg-background text-foreground">
	<ChatSidebar />

	<div class="min-w-0 flex-1 overflow-hidden">
		{@render children()}
	</div>
</div>
