<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount, tick } from 'svelte';
	import ChatMessageItem from './ChatMessageItem.svelte';
	import type { ChatMessage } from './chat.types';

	let {
		messages,
		onReply = () => {},
		onReact = () => Promise.resolve(),
		onEdit = () => {},
		onDelete = () => Promise.resolve(),
		onVisibleUnreadReference = () => {}
	}: {
		messages: ChatMessage[];
		onReply?: (message: ChatMessage) => void;
		onReact?: (message: ChatMessage, reaction: string) => void | Promise<void>;
		onEdit?: (message: ChatMessage) => void;
		onDelete?: (message: ChatMessage) => void | Promise<void>;
		onVisibleUnreadReference?: (message: ChatMessage) => void;
	} = $props();
	let container: HTMLDivElement | null = $state(null);
	let highlightedMessageId = $state('');
	let highlightTimeout: number | null = null;
	let wasAtBottom = true;
	let suppressNextAutoScroll = false;

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

	export async function scrollToBottom() {
		await tick();
		if (!browser || !container) return;
		container.scrollTo({
			top: container.scrollHeight,
			behavior: 'instant'
		});
	}

	export async function scrollToMessage(messageId: string) {
		await tick();
		await navigateToMessage(messageId);
	}

	function isAtBottom() {
		if (!container) return true;
		return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
	}

	function markVisibleUnreadReferences() {
		if (!browser || !container) return;
		const containerRect = container.getBoundingClientRect();

		for (const message of messages) {
			if (!message.unreadReference) continue;
			const element = container.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
			if (!element) continue;

			const elementRect = element.getBoundingClientRect();
			const isVisible =
				elementRect.top < containerRect.bottom && elementRect.bottom > containerRect.top;
			if (isVisible) {
				onVisibleUnreadReference(message);
			}
		}
	}

	function handleScroll() {
		wasAtBottom = isAtBottom();
		markVisibleUnreadReferences();
	}

	function centerMessage(element: HTMLElement) {
		if (!container) return;
		const containerRect = container.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();
		const currentTop = container.scrollTop;
		const delta =
			elementRect.top - containerRect.top - container.clientHeight / 2 + elementRect.height / 2;
		container.scrollTo({ top: Math.max(0, currentTop + delta), behavior: 'instant' });
	}

	onMount(() => {
		scrollToBottom();
	});

	$effect(() => {
		messages.length;
		if (!browser || !container) return;

		const shouldScroll = wasAtBottom;
		void tick().then(() => {
			if (suppressNextAutoScroll) {
				suppressNextAutoScroll = false;
			} else if (shouldScroll) {
				container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
			}
			wasAtBottom = isAtBottom();
			markVisibleUnreadReferences();
		});
	});

	async function navigateToMessage(messageId: string) {
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

		suppressNextAutoScroll = true;
		centerMessage(element);
		await tick();
		centerMessage(element);
		wasAtBottom = isAtBottom();
		markVisibleUnreadReferences();
	}

	$effect(() => {
		return () => {
			if (highlightTimeout) {
				clearTimeout(highlightTimeout);
			}
		};
	});
</script>

<div
	bind:this={container}
	class="h-full overflow-x-hidden overflow-y-auto overscroll-contain"
	onscroll={handleScroll}
>
	<div
		class="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-4 px-3 py-4 sm:gap-5 sm:px-4 sm:py-5 md:gap-6 md:px-6 md:py-8"
	>
		{#each groupedMessages as entry (entry.message.id)}
			<ChatMessageItem
				message={entry.message}
				showAuthor={entry.showAuthor}
				showAvatar={entry.showAvatar}
				showDayLabel={entry.showDayLabel}
				{onReply}
				{onReact}
				{onEdit}
				{onDelete}
				onNavigateToMessage={navigateToMessage}
				highlighted={highlightedMessageId === entry.message.id}
			/>
		{/each}
	</div>
</div>
