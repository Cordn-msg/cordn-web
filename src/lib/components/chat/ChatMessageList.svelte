<script lang="ts">
	import { browser } from '$app/environment';
	import ChatMessageItem from './ChatMessageItem.svelte';
	import type { ChatMessage } from './chat.types';

	let { messages }: { messages: ChatMessage[] } = $props();
	let container: HTMLDivElement | null = $state(null);

	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		messages;

		if (!browser || !container) {
			return;
		}

		setTimeout(() => {
			container?.scrollTo({
				top: container.scrollHeight,
				behavior: 'smooth'
			});
		}, 0);
	});
</script>

<div bind:this={container} class="h-full overflow-y-auto">
	<div class="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
		{#each messages as message (message.id)}
			<ChatMessageItem {message} />
		{/each}
	</div>
</div>
