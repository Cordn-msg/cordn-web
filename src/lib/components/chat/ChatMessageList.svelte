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
		initialFocusMessageId = '',
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
		/** Open-at-first-unread target ("<eventId>:<cursor>"), set once per group by
		 *  ChatShell before the group is marked read. Empty → open at the bottom. */
		initialFocusMessageId?: string;
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
	// Open-at-first-unread bookkeeping: the focus id already consumed, and a
	// monotonic token so a newer programmatic scroll invalidates older in-flight
	// ones (mount → focus and group-switch → focus can overlap mid-await).
	let consumedFocusId = '';
	let scrollRun = 0;

	const ESTIMATED_MESSAGE_HEIGHT = 128;
	const VIRTUAL_OVERSCAN = 8;

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
		const run = ++scrollRun;
		await tick();
		if (!browser || !container || messages.length === 0 || run !== scrollRun) return;

		$virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
		await tick();
		if (run !== scrollRun) return;
		measureVisibleItems();
		await tick();
		if (run !== scrollRun || !container) return;
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

	// Open-at-first-unread: land with the first unread message (and its "New
	// messages" marker) at the TOP of the viewport, WhatsApp-style.
	//
	// Virtualizer gotcha this dances around: scrollToIndex reads
	// measurementsCache — measured rows plus a 128px estimate for every row
	// that never rendered. The cache is *self-consistent* (row translateY and
	// the spacer height come from the same numbers), so pass 1 always mounts the
	// target row even when its cached offset is wrong in absolute terms. But
	// once pass 1's rows get measured the cache shifts, so the final position
	// must come from DOM geometry (navigateToMessage's trick), not from a
	// second scrollToIndex. Returns false when the target isn't in the list
	// (consumer falls back to the bottom-pin).
	async function scrollToFocusMessage(messageId: string): Promise<boolean> {
		if (!browser || !container) return false;
		const index = messages.findIndex((message) => message.id === messageId);
		if (index === -1) return false;

		consumedFocusId = messageId;
		const run = ++scrollRun;
		// Suppress the totalSize re-pin while measurements settle (same guard
		// navigateToMessage uses).
		suppressNextAutoScroll = true;
		$virtualizer.scrollToIndex(index, { align: 'start' });
		await tick();
		if (run !== scrollRun) return true;
		measureVisibleItems();
		await tick();
		// Anchor to the ROW (not the bubble) so the unread marker renders inside
		// the viewport top; double pass because late measurements keep settling.
		const row = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
		if (row) {
			positionMessage(row, 'top');
			await tick();
			if (run !== scrollRun) return true;
			positionMessage(row, 'top');
		}
		updateBottomState();
		markVisibleUnreadReferences();
		return true;
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

	// DOM-anchored positioning (immune to virtualizer estimate error above the
	// target): rects are truth, cache-derived translateY offsets are not — see
	// scrollToFocusMessage.
	function positionMessage(element: HTMLElement, align: 'top' | 'center') {
		if (!container) return;
		const containerRect = container.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();
		const currentTop = container.scrollTop;
		const delta =
			align === 'top'
				? elementRect.top - containerRect.top
				: elementRect.top - containerRect.top - container.clientHeight / 2 + elementRect.height / 2;
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
		// Initial positioning (bottom-pin or first-unread focus) is owned by the
		// messages $effect below — it runs on mount too. Here: keep the container
		// shrink observer (soft keyboard) only.

		// Re-pin to the bottom when the scroll container itself shrinks — most importantly the soft
		// keyboard opening on mobile — so the latest messages stay visible instead of being clipped
		// off the new bottom edge. Guarded by wasAtBottom (never yank someone reading history) and
		// rAF-batched so the multi-frame keyboard animation collapses to one cheap scrollTo.
		let resizeFrame: number | null = null;
		const ro = new ResizeObserver(() => {
			if (!container || !wasAtBottom) return;
			if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
			resizeFrame = requestAnimationFrame(() => {
				resizeFrame = null;
				if (container && wasAtBottom) {
					container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
				}
			});
		});
		if (container) ro.observe(container);
		return () => {
			ro.disconnect();
			if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
		};
	});

	$effect(() => {
		const messageCount = messages.length;
		const lastMessageId = messages.at(-1)?.id;
		const focusId = initialFocusMessageId;
		if (!browser || !container) return;
		untrack(() => {
			$virtualizer.setOptions({
				count: messageCount,
				getScrollElement: () => container,
				getItemKey: (index) => messages[index]?.id ?? index
			});
		});

		const shouldScroll = wasAtBottom;
		void tick().then(async () => {
			void messageCount;
			void lastMessageId;
			measureVisibleItems();
			if (suppressNextAutoScroll) {
				suppressNextAutoScroll = false;
			} else {
				// Land on the first unread message when the chat opens with one;
				// otherwise keep the classic bottom-pin for new arrivals.
				const focused = focusId !== consumedFocusId && (await scrollToFocusMessage(focusId));
				if (!focused && shouldScroll) void scrollToLatestMessage();
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

		positionMessage(element, 'center');
		await tick();
		positionMessage(element, 'center');
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
					{@const message = messages[virtualItem.index]}
					{#if message}
						{@const previousMessage = messages[virtualItem.index - 1]}
						{@const nextMessage = messages[virtualItem.index + 1]}
						{@const systemRow = Boolean(message.systemKind)}
						<div
							data-index={virtualItem.index}
							data-virtual-item
							data-message-id={message.id}
							class="absolute top-0 left-0 w-full pb-4 sm:pb-5 md:pb-6"
							style={`transform: translateY(${virtualItem.start}px);`}
							use:measureItem
						>
							<ChatMessageItem
								{message}
								showAuthor={!systemRow && previousMessage?.author !== message.author}
								showAvatar={!systemRow && nextMessage?.author !== message.author}
								showDayLabel={previousMessage?.dayLabel !== message.dayLabel}
								showUnreadMarker={message.id === initialFocusMessageId}
								{onReply}
								{onReact}
								{onEdit}
								{onDelete}
								{onRetrySend}
								onNavigateToMessage={navigateToMessage}
								{onOpenRich}
								{onPin}
								highlighted={highlightedMessageId === message.id}
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
