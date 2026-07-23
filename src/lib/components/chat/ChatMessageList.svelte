<script lang="ts">
	import { browser } from '$app/environment';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import { onMount, tick, untrack } from 'svelte';
	import { scale } from 'svelte/transition';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button';
	import ChatMessageItem from './ChatMessageItem.svelte';
	import type { ChatMessage } from './chat.types';

	let {
		messages,
		onReply = () => {},
		onReact = () => Promise.resolve(),
		onEdit = () => {},
		onDelete = () => Promise.resolve(),
		onRetrySend = () => {},
		onVisibleUnreadReference = () => {},
		onOpenRich = () => {},
		onPin = () => {}
	}: {
		messages: ChatMessage[];
		onReply?: (message: ChatMessage) => void;
		onReact?: (message: ChatMessage, reaction: string) => void | Promise<void>;
		onEdit?: (message: ChatMessage) => void;
		onDelete?: (message: ChatMessage) => void | Promise<void>;
		onRetrySend?: (message: ChatMessage) => void | Promise<void>;
		onVisibleUnreadReference?: (message: ChatMessage) => void;
		onOpenRich?: (eventId: string) => void;
		onPin?: (message: ChatMessage) => void;
	} = $props();
	let container: HTMLDivElement | null = $state(null);
	let highlightedMessageId = $state('');
	let highlightTimeout: number | null = null;
	let unreadReferenceFrame: number | null = null;
	let wasAtBottom = true;
	let showScrollToBottom = $state(false);
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

	function updateBottomState() {
		wasAtBottom = isAtBottom();
		showScrollToBottom = !wasAtBottom;
	}

	function handleScroll() {
		updateBottomState();
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

	// Ongoing per-row measurement: the virtualizer's built-in `measureElement`
	// observes each row, so when a row resizes after mount — a media image
	// finishing its async load, or a progress bar appearing — `totalSize` updates.
	// The batch `measureVisibleItems` above is a one-shot; this adds the continuous
	// ResizeObserver that keeps the layout honest post-scroll (one shared RO for
	// all rows, as tanstack ships it).
	function measureItem(node: HTMLDivElement) {
		$virtualizer.measureElement(node);
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
			updateBottomState();
			markVisibleUnreadReferences();
		});
	});

	// Re-pin to the bottom when content resizes while stuck there. Catches async
	// media loads (local blob previews, decrypted fetches) that grow a row AFTER
	// the new-message scroll already ran — the source of the "need to scroll down a
	// bit" gap on media. Guarded by `wasAtBottom` (never yank someone reading
	// history) and `suppressNextAutoScroll` (don't fight a navigate-to-message).
	$effect(() => {
		void totalSize;
		if (!browser || !container) return;
		if (!wasAtBottom || suppressNextAutoScroll) return;
		void tick().then(() => {
			if (wasAtBottom && !suppressNextAutoScroll && container) {
				container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
			}
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
		updateBottomState();
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

<div class="relative h-full">
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
							use:measureItem
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
								{onRetrySend}
								onNavigateToMessage={navigateToMessage}
								{onOpenRich}
								{onPin}
								highlighted={highlightedMessageId === entry.message.id}
							/>
						</div>
					{/if}
				{/each}
			</div>
		</div>
	</div>

	{#if showScrollToBottom}
		<div
			class="absolute right-4 bottom-4 z-10 md:right-6"
			transition:scale={{ start: 0.8, duration: 150 }}
		>
			<Button
				type="button"
				size="icon"
				variant="secondary"
				class="h-10 w-10 rounded-full shadow-lg"
				onclick={scrollToBottom}
				aria-label="Scroll to bottom"
			>
				<ChevronDown class="size-5" />
			</Button>
		</div>
	{/if}
</div>
