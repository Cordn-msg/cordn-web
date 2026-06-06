<script lang="ts">
	import { browser } from '$app/environment';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import { onMount, tick, untrack } from 'svelte';
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
	let unreadReferenceFrame: number | null = null;
	let wasAtBottom = true;
	let suppressNextAutoScroll = false;

	const ESTIMATED_MESSAGE_HEIGHT = 128;
	const VIRTUAL_OVERSCAN = 8;

	const groupedMessages = $derived.by(() =>
		messages.map((message, index) => {
			const previousMessage = index > 0 ? messages[index - 1] : null;
			const nextMessage = index < messages.length - 1 ? messages[index + 1] : null;

			if (message.systemKind) {
				return {
					message,
					showAuthor: false,
					showAvatar: false,
					showDayLabel: previousMessage?.dayLabel !== message.dayLabel
				};
			}

			return {
				message,
				showAuthor: previousMessage?.author !== message.author,
				showAvatar: nextMessage?.author !== message.author,
				showDayLabel: previousMessage?.dayLabel !== message.dayLabel
			};
		})
	);

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => container,
		estimateSize: () => ESTIMATED_MESSAGE_HEIGHT,
		overscan: VIRTUAL_OVERSCAN,
		getItemKey: (index) => messages[index]?.id ?? index
	});

	const virtualItems = $derived($virtualizer.getVirtualItems());
	const totalSize = $derived($virtualizer.getTotalSize());

	async function scrollToLatestMessage() {
		await tick();
		if (!browser || !container || messages.length === 0) return;

		$virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
		await tick();
		measureVisibleItems();
		await tick();
		container.scrollTo({
			top: container.scrollHeight,
			behavior: 'instant'
		});
	}

	export async function scrollToBottom() {
		await scrollToLatestMessage();
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

		for (const virtualItem of virtualItems) {
			const message = messages[virtualItem.index];
			if (!message) continue;
			if (message.systemKind) continue;
			if (!message.unreadReference) continue;
			const element = container.querySelector<HTMLElement>(
				`[data-index="${virtualItem.index}"] [data-message-id]`
			);
			if (!element) continue;

			const elementRect = element.getBoundingClientRect();
			const isVisible =
				elementRect.top < containerRect.bottom && elementRect.bottom > containerRect.top;
			if (isVisible) {
				onVisibleUnreadReference(message);
			}
		}
	}

	function scheduleVisibleUnreadReferenceCheck() {
		if (!browser) return;
		if (unreadReferenceFrame !== null) return;
		unreadReferenceFrame = window.requestAnimationFrame(() => {
			unreadReferenceFrame = null;
			markVisibleUnreadReferences();
		});
	}

	function handleScroll() {
		wasAtBottom = isAtBottom();
		scheduleVisibleUnreadReferenceCheck();
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

	function measureVisibleItems() {
		if (!browser || !container) return;
		for (const element of container.querySelectorAll<HTMLDivElement>('[data-virtual-item]')) {
			$virtualizer.measureElement(element);
		}
	}

	onMount(() => {
		void tick().then(() => {
			untrack(() => {
				$virtualizer.setOptions({
					count: messages.length,
					getScrollElement: () => container,
					getItemKey: (index) => messages[index]?.id ?? index
				});
				$virtualizer.measure();
			});
			void scrollToLatestMessage();
		});
	});

	$effect(() => {
		const messageCount = messages.length;
		const lastMessageId = messages.at(-1)?.id;
		if (!browser || !container) return;
		untrack(() => {
			$virtualizer.setOptions({
				count: messageCount,
				getScrollElement: () => container,
				getItemKey: (index) => messages[index]?.id ?? index
			});
		});

		const shouldScroll = wasAtBottom;
		void tick().then(() => {
			void messageCount;
			void lastMessageId;
			measureVisibleItems();
			if (suppressNextAutoScroll) {
				suppressNextAutoScroll = false;
			} else if (shouldScroll) {
				void scrollToLatestMessage();
			}
			wasAtBottom = isAtBottom();
			markVisibleUnreadReferences();
		});
	});

	async function navigateToMessage(messageId: string) {
		if (!browser || !container) return;
		const messageIndex = messages.findIndex((message) => message.id === messageId);
		if (messageIndex === -1) return;

		suppressNextAutoScroll = true;
		$virtualizer.scrollToIndex(messageIndex, { align: 'center' });
		await tick();
		measureVisibleItems();
		await tick();

		const element = container.querySelector<HTMLElement>(
			`[data-index="${messageIndex}"] [data-message-id]`
		);
		if (!element) return;

		highlightedMessageId = messageId;
		if (highlightTimeout) {
			clearTimeout(highlightTimeout);
		}
		highlightTimeout = window.setTimeout(() => {
			highlightedMessageId = '';
		}, 2400);

		centerMessage(element);
		await tick();
		centerMessage(element);
		wasAtBottom = isAtBottom();
		markVisibleUnreadReferences();
	}

	$effect(() => {
		return () => {
			if (unreadReferenceFrame !== null) {
				window.cancelAnimationFrame(unreadReferenceFrame);
			}
			if (highlightTimeout) {
				clearTimeout(highlightTimeout);
			}
		};
	});

	$effect(() => {
		void virtualItems;
		void tick().then(measureVisibleItems);
	});
</script>

<div
	bind:this={container}
	class="h-full overflow-x-hidden overflow-y-auto overscroll-contain"
	onscroll={handleScroll}
>
	<div class="mx-auto min-h-full w-full max-w-5xl px-3 py-4 sm:px-4 sm:py-5 md:px-6 md:py-8">
		<div class="relative w-full" style={`height: ${totalSize}px;`}>
			{#each virtualItems as virtualItem (virtualItem.key)}
				{@const entry = groupedMessages[virtualItem.index]}
				{#if entry}
					<div
						data-index={virtualItem.index}
						data-virtual-item
						data-message-id={entry.message.id}
						class="absolute top-0 left-0 w-full pb-4 sm:pb-5 md:pb-6"
						style={`transform: translateY(${virtualItem.start}px);`}
					>
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
					</div>
				{/if}
			{/each}
		</div>
	</div>
</div>
