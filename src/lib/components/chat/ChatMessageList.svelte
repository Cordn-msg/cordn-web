<script lang="ts">
	import { browser } from '$app/environment';
	import ChatMessageItem from './ChatMessageItem.svelte';
	import type { ChatMessage } from './chat.types';

	let { messages }: { messages: ChatMessage[] } = $props();
	let container: HTMLDivElement | null = $state(null);

	const groupedMessages = $derived.by(() =>
		messages.map((message, index) => {
			const previousMessage = index > 0 ? messages[index - 1] : null;
			const nextMessage = index < messages.length - 1 ? messages[index + 1] : null;

			return {
				message,
				showAuthor: previousMessage?.author !== message.author,
				showAvatar: nextMessage?.author !== message.author,
				showDayLabel: previousMessage?.dayLabel !== message.dayLabel
			};
		})
	);

	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		messages;

		if (!browser || !container) {
			return;
		}

		container?.scrollTo({
			top: container.scrollHeight,
			behavior: 'instant'
		});
	});
</script>

<div bind:this={container} class="h-full overflow-y-auto">
	<div class="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
		{#each groupedMessages as entry (entry.message.id)}
			<ChatMessageItem
				message={entry.message}
				showAuthor={entry.showAuthor}
				showAvatar={entry.showAvatar}
				showDayLabel={entry.showDayLabel}
			/>
		{/each}
	</div>
</div>
