<script lang="ts">
	import { browser } from '$app/environment';
	import ChatMessageItem from './ChatMessageItem.svelte';
	import type { ChatMessage } from './chat.types';

	let {
		messages,
		onReply = () => {},
		onReact = () => Promise.resolve()
	}: {
		messages: ChatMessage[];
		onReply?: (message: ChatMessage) => void;
		onReact?: (message: ChatMessage, reaction: string) => void | Promise<void>;
	} = $props();
	let container: HTMLDivElement | null = $state(null);
	let highlightedMessageId = $state('');
	let highlightTimeout: number | null = null;

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

	function navigateToMessage(messageId: string) {
		if (!browser || !container) return;

		const element = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
		if (!element) return;

		highlightedMessageId = messageId;
		if (highlightTimeout) {
			clearTimeout(highlightTimeout);
		}
		highlightTimeout = window.setTimeout(() => {
			highlightedMessageId = '';
		}, 2400);

		element.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	$effect(() => {
		return () => {
			if (highlightTimeout) {
				clearTimeout(highlightTimeout);
			}
		};
	});
</script>

<div bind:this={container} class="h-full overflow-x-hidden overflow-y-auto">
	<div class="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
		{#each groupedMessages as entry (entry.message.id)}
			<ChatMessageItem
				message={entry.message}
				showAuthor={entry.showAuthor}
				showAvatar={entry.showAvatar}
				showDayLabel={entry.showDayLabel}
				{onReply}
				{onReact}
				onNavigateToMessage={navigateToMessage}
				highlighted={highlightedMessageId === entry.message.id}
			/>
		{/each}
	</div>
</div>
