<script lang="ts">
	import { browser } from '$app/environment';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import { onMount, tick, untrack } from 'svelte';
	import { scale } from 'svelte/transition';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import AtSign from '@lucide/svelte/icons/at-sign';
	import { Button } from '$lib/components/ui/button';
	import ChatMessageItem from './ChatMessageItem.svelte';
	import { estimateChatMessageHeight } from './chatMessageRenderCache';
	import { shouldAnchorPrepend } from './chatListScrollAnchor';
	import { chatDayKey, formatChatDayLabel } from './chatDayLabel';
	import { isRunTail } from './chatRunGrouping';
	import type { ChatMessage } from './chat.types';

	let {
		messages,
		groupId = '',
		initialFocusCursor = 0,
		ensureMessage,
		onLoadOlder,
		onReply = () => {},
		onReact = () => Promise.resolve(),
		onUnreact = () => Promise.resolve(),
		onEdit = () => {},
		onDelete = () => Promise.resolve(),
		onRetrySend = () => {},
		onSendWithoutEmoji = () => {},
		onVisibleUnreadReference = () => {},
		onVisibleRead = () => {},
		onOpenRich = () => {},
		onPin = () => {},
		onVote = () => Promise.resolve(false),
		unreadReferenceCount = 0,
		onNavigateToReference = () => {}
	}: {
		messages: ChatMessage[];
		/** Group the rows belong to — poll rows self-query their votes from here. */
		groupId?: string;
		/** Unread @-mentions of the viewer: shown as a floating jump button
		 *  stacked above scroll-to-bottom (moved out of the composer). */
		unreadReferenceCount?: number;
		onNavigateToReference?: () => void | Promise<void>;
		/** Open-at-first-unread target cursor, set once per group by ChatShell on
		 *  open (0 = open at the bottom). Cursor-based so a gap start below the
		 *  loaded window can be loaded before landing (docs/long-history.md). */
		initialFocusCursor?: number;
		/** Load the history page around `cursor` (windowed history: jump and focus
		 *  targets may not be loaded yet). */
		ensureMessage?: (cursor: number) => Promise<void>;
		/** Load the next history page below the window; returns the rows fetched
		 *  (falsy = the group's history start was reached). */
		onLoadOlder?: () => Promise<number | void>;
		onReply?: (message: ChatMessage) => void;
		onReact?: (message: ChatMessage, reaction: string) => void | Promise<void>;
		onUnreact?: (message: ChatMessage, reaction: string) => void | Promise<void>;
		onEdit?: (message: ChatMessage) => void;
		onDelete?: (message: ChatMessage) => void | Promise<void>;
		onRetrySend?: (message: ChatMessage) => void | Promise<void>;
		onSendWithoutEmoji?: (message: ChatMessage) => void | Promise<void>;
		onVisibleUnreadReference?: (message: ChatMessage) => void;
		/** Visibility-based read marking: reports the highest message cursor
		 *  actually on screen (plus whether the viewport sits at the bottom, where
		 *  folded annotations without rows mean "mark everything stored"). Called
		 *  only from settled positions — never mid programmatic-scroll flight. */
		onVisibleRead?: (report: { cursor: number; atBottom: boolean }) => void;
		onOpenRich?: (eventId: string) => void;
		onPin?: (message: ChatMessage) => void;
		/** Cast a poll vote (kind 1018): complete selection of option ids. */
		onVote?: (message: ChatMessage, optionIds: string[]) => void | Promise<boolean>;
	} = $props();
	let container: HTMLDivElement | null = $state(null);
	let highlightedMessageId = $state('');
	let highlightTimeout: number | null = null;
	let unreadReferenceFrame: number | null = null;
	let wasAtBottom = true;
	let showScrollToBottom = $state(false);
	// Floating day chip (Telegram-style): the day of the topmost visible row,
	// shown while scrolling up, hidden when scrolling down and after the scroll
	// stops. Kept as state (not derived from virtualItems) so it only repaints on
	// label/visibility changes, not on every scroll tick.
	let floatingDayLabel = $state('');
	let floatingDayVisible = $state(false);
	let floatingDayFrame: number | null = null;
	let floatingDayHideTimer: number | null = null;
	let floatingDayRetryTimer: number | null = null;
	let floatingDayRetries = 0;
	// Accumulated scroll movement since the chip last acted on it: slow
	// trackpad/momentum deltas are often < 2px per event, so per-event
	// thresholds would never fire. Direction is decided once a whole gesture
	// clears FLOATING_DAY_DIRECTION_PX.
	let floatingDayScrollDelta = 0;
	// Programmatic scroll corrections (prepend anchor restore, load-older height
	// compensation) move scrollTop DOWNWARD while the user is scrolling UP —
	// ignore their scroll events so they can't hide the chip mid-read.
	let floatingDaySuppressUntil = 0;
	let lastScrollTop = 0;
	let suppressNextAutoScroll = false;
	// Open-at-first-unread bookkeeping: the focus cursor already consumed, and a
	// monotonic token so a newer programmatic scroll invalidates older in-flight
	// ones (mount → focus and group-switch → focus can overlap mid-await).
	let consumedFocusCursor = 0;
	let scrollRun = 0;
	// History paging (docs/long-history.md): scroll-up prepends older pages.
	let historyExhaustedForGroup = '';
	let loadOlderInFlight = false;
	// Identity gate for the messages effect: the owner's `messages` derivation
	// hands the list a fresh array on unrelated state changes (presence,
	// unread-reference maps); each of those used to re-run the measure +
	// bottom-pin continuation, and the competing scrolls jittered the view on
	// every composer keystroke. Only real list changes may re-measure/re-pin.
	let appliedGroupId = '';
	let appliedMessageCount = -1;
	let appliedLastMessageId = '';
	let appliedFirstMessageId = '';
	let appliedFocusCursor = -1;

	// The scrollRun value of the last COMPLETED programmatic flight. While
	// scrollRun !== settledRun a flight is mid-air and the visible window is
	// transient (focus jumps pass over the tail) — visibility-based read
	// marking must wait for the final position. Equal values = user scroll only.
	let settledRun = 0;

	const ESTIMATED_MESSAGE_HEIGHT = 128;
	const VIRTUAL_OVERSCAN = 8;
	const FLOATING_DAY_HIDE_MS = 1000;
	const FLOATING_DAY_SUPPRESS_MS = 200;
	const FLOATING_DAY_DIRECTION_PX = 8;
	const FLOATING_DAY_RETRY_MS = 100;
	const FLOATING_DAY_MAX_RETRIES = 10;

	// The virtualizer must only see list changes when the messages effect
	// applies them through setOptions. estimateSize/getItemKey closures reading
	// the reactive `messages` prop made every identity change (store writes,
	// presence ticks) re-run the totalSize/virtualItems derivations mid-flush,
	// re-rendering the virtualized DOM with a STALE count over SHIFTED rows —
	// the "lands on the new messages, then jumps higher" open race: the prepend
	// anchor then measured that franken-DOM height and restored to a wrong
	// offset. A plain snapshot severs the accidental coupling.
	// svelte-ignore non_reactive_update
	let messageSnapshot: ChatMessage[] = [];

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => container,
		// Shape-aware estimates shrink the estimate→measure deltas that make
		// first-pass scrolls jump; measured rows keep their real heights.
		estimateSize: (index) => {
			const message = messageSnapshot[index];
			return message ? estimateChatMessageHeight(message) : ESTIMATED_MESSAGE_HEIGHT;
		},
		overscan: VIRTUAL_OVERSCAN,
		getItemKey: (index) => messageSnapshot[index]?.id ?? index
	});
	// Class field, not an option (setOptions never touches it), assigned once.
	// ($store reads are safe, but `$store.prop = …` compiles to store.set() and
	// this store is derived/read-only — so assign through a plain local.)
	// The default only absorbs above-viewport resizes while scrolling forward
	// — during backward scroll (up-paging) uncorrected resizes drift the fold —
	// and until 3.19 it also corrected fold-STRADDLING rows, whose growth is
	// below the fold: that dragged the freshly landed view into the message
	// (upstream #1218). Mirror the fixed default (first measure: above the
	// fold; re-measure: ENTIRELY above it) minus the direction clause, plus a
	// bottom-pin carve-out.
	const virtualizerInstance = $virtualizer;
	virtualizerInstance.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
		// Never drag a viewport that owns its bottom position: rows settling from
		// estimate to measured height (short text, a new reaction chip growing its
		// row) would otherwise adjust by the item delta while the totalSize re-pin
		// below scrolls to the absolute bottom — two competing scroll targets for
		// a frame or three, which reads as the list bouncing until they agree. The
		// re-pin is guarded by the same wasAtBottom, so bottom-positioning belongs
		// to it alone; the raw clamp check stays as a backstop for positions the
		// tracker has not sampled yet (programmatic scrolls).
		const el = container;
		if (el && (wasAtBottom || el.scrollHeight - el.scrollTop - el.clientHeight <= 2)) {
			return false;
		}
		const offset = el?.scrollTop ?? 0;
		return measuredRowKeys.has(item.key) ? item.start + item.size <= offset : item.start < offset;
	};

	const virtualItems = $derived($virtualizer.getVirtualItems());
	const totalSize = $derived($virtualizer.getTotalSize());
	// The "New messages" line rides the row the focus flight lands on (the first
	// row at/after the focus cursor — the gap start may fall between cursors).
	const focusMarkerId = $derived.by(() => {
		if (initialFocusCursor <= 0) return '';
		return messages.find((message) => (message.cursor ?? 0) >= initialFocusCursor)?.id ?? '';
	});

	async function scrollToLatestMessage() {
		const run = ++scrollRun;
		await tick();
		if (!browser || !container || messages.length === 0 || run !== scrollRun) return;

		// Already at the bottom: the tail rows are mounted and measured, so pin
		// to the DOM truth directly — scrollToIndex would aim at totalSize minus
		// a cached viewport rect that can lag the live container (composer wrap,
		// soft keyboard) and un-pin the view mid-flight.
		if (!isAtBottom()) {
			$virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
			await tick();
			if (run !== scrollRun) return;
			measureVisibleItems();
			await tick();
			if (run !== scrollRun || !container) return;
		}
		container.scrollTo({
			top: container.scrollHeight,
			behavior: 'instant'
		});
		settledRun = run;
	}

	export async function scrollToBottom() {
		await scrollToLatestMessage();
	}

	export async function scrollToMessage(messageId: string) {
		await tick();
		await navigateToMessage(messageId);
	}

	// scrollToIndex reads measurementsCache — measured rows plus estimates for
	// rows that never rendered. A deep target's estimated offset can overshoot
	// the real content entirely (the jump clamps at the end and the row never
	// mounts), so converge: jump, measure what rendered, jump again with the
	// corrected offsets. Targeted by message ID, re-resolved every attempt: a
	// window merge landing mid-flight shifts indices, and a stale index jumps
	// to whatever older row inherited it. Returns the target row or null when
	// it never rendered.
	async function jumpToRow(
		targetId: string,
		align: 'start' | 'center',
		run: number
	): Promise<HTMLElement | null> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const index = messages.findIndex((message) => message.id === targetId);
			if (index === -1) return null;
			$virtualizer.scrollToIndex(index, { align });
			// The virtual window recomputes on the element's scroll event, which
			// lands after every microtask — wait for the next frame or the row
			// lookup races the render and misses a row that is in fact mounted.
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			await tick();
			if (run !== scrollRun || !container) return null;
			measureVisibleItems();
			await tick();
			if (run !== scrollRun || !container) return null;
			const row = container.querySelector<HTMLElement>(
				`[data-message-id="${CSS.escape(targetId)}"]`
			);
			if (row) return row;
		}
		return null;
	}

	// Open-at-first-unread: land with the first unread message (and its "New
	// messages" marker) at the TOP of the viewport, WhatsApp-style. The final
	// position comes from DOM geometry (not another scrollToIndex) so late
	// measurements can't drift it. Cursor-based: the gap start may sit below the
	// loaded window, so load its page first (decision 6). Returns false when no
	// row renders at/after the cursor (consumer falls back to the bottom-pin).
	async function scrollToFocusMessage(focusCursor: number): Promise<boolean> {
		if (!browser || !container) return false;
		// Run token from ENTRY, not after the page load: every await below can
		// be superseded, and ownership (run === scrollRun) is what makes the
		// suppression clears safe — a superseded flight must never clear its
		// successor's flag.
		const run = ++scrollRun;
		let index = messages.findIndex((message) => (message.cursor ?? 0) >= focusCursor);
		if (index === -1 && ensureMessage) {
			// Hold the focus flight across the load: no bottom-pin may claim the
			// scroll while the page loads.
			wasAtBottom = false;
			suppressNextAutoScroll = true;
			await ensureMessage(focusCursor);
			await tick();
			// Superseded: a newer flight owns the scroll now. Return TRUE so the
			// caller skips its bottom-pin fallback — that fallback would take the
			// token itself and clobber the successor's landing mid-flight.
			if (run !== scrollRun) return true;
			index = messages.findIndex((message) => (message.cursor ?? 0) >= focusCursor);
		}
		if (index === -1) {
			// No target — the flight is over, so its suppression is too. The flag
			// used to leak from every bail-out and stale-suppress the first
			// post-open window growth (the anchor and bottom re-pin both skip).
			// Settling matters as much as clearing: a stranded scrollRun >
			// settledRun freezes visibility read-marking until some later
			// programmatic scroll happens to settle it.
			suppressNextAutoScroll = false;
			settledRun = run;
			return false;
		}

		consumedFocusCursor = focusCursor;
		// The focus flight owns the scroll: mark "not at bottom" so no auto-scroll
		// actor (message-arrival effect re-runs, the container RO, the totalSize
		// re-pin) can race it back to the latest message mid-flight.
		wasAtBottom = false;
		// Suppress the totalSize re-pin while measurements settle (same guard
		// navigateToMessage uses).
		suppressNextAutoScroll = true;
		// Anchor to the ROW (not the bubble) so the unread marker renders inside
		// the viewport top; double pass because late measurements keep settling.
		const row = await jumpToRow(messages[index].id, 'start', run);
		if (run !== scrollRun) return true;
		if (!row) {
			suppressNextAutoScroll = false;
			settledRun = run; // we still own the token — settle or read-marking freezes
			return false; // target vanished mid-flight — fall back to bottom-pin
		}
		positionMessage(row, 'top');
		await tick();
		if (run !== scrollRun) return true;
		positionMessage(row, 'top');
		updateBottomState();
		// End the suppression with the flight that raised it. Leaving it for the
		// next messages-effect run let the open-time window merge (the prepend
		// right after landing) arrive while the flag was still up: both the
		// anchor guard and the bottom re-pin skipped it, and the landed view slid
		// up into older history — the lands-then-jumps race.
		suppressNextAutoScroll = false;
		settledRun = run;
		markVisibleUnreadReferences();
		return true;
	}

	// First row intersecting the viewport top (the reading anchor): its id plus
	// the pixel offset it sits at, so a window merge that inserts older rows
	// ABOVE it can restore the exact reading position afterwards.
	function captureAnchorRow(): { id: string; viewportOffset: number } | null {
		if (!container) return null;
		const containerTop = container.getBoundingClientRect().top;
		for (const element of container.querySelectorAll<HTMLElement>('[data-virtual-item]')) {
			const rect = element.getBoundingClientRect();
			if (rect.bottom > containerTop + 1) {
				return { id: element.dataset.messageId ?? '', viewportOffset: rect.top - containerTop };
			}
		}
		return null;
	}

	// Anchor restore = a mini flight through the same convergence machinery the
	// focus landing uses (scrollToIndex + measured final position). Raw scrollTop
	// writes fought the virtualizer's scroll-reconcile bookkeeping and stranded
	// the rendered window off-viewport — the "jumped higher and stayed" endgame.
	async function restoreAnchorRow(anchor: { id: string; viewportOffset: number }): Promise<void> {
		const run = ++scrollRun;
		const element = await jumpToRow(anchor.id, 'start', run);
		// Superseded: the successor owns settling. Anchor unrecoverable (a window
		// trim evicted the row): settle what we took anyway — a stranded
		// scrollRun > settledRun freezes visibility read-marking and every later
		// anchor until some other programmatic scroll settles it.
		if (run !== scrollRun) return;
		if (!element || !container) {
			settledRun = run;
			return;
		}
		// jumpToRow pinned the row's TOP to the viewport top; nudge it back to
		// its exact captured reading offset.
		const delta =
			element.getBoundingClientRect().top -
			container.getBoundingClientRect().top -
			anchor.viewportOffset;
		container.scrollTop += delta;
		// This correction moves scrollTop downward while the reader scrolls up.
		// Keep the day chip up and let the next real upward scroll take over.
		lastScrollTop = container.scrollTop;
		floatingDayScrollDelta = 0;
		floatingDaySuppressUntil = performance.now() + FLOATING_DAY_SUPPRESS_MS;
		settledRun = run;
	}

	function isAtBottom() {
		if (!container) return true;
		return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
	}

	// Visible-content pass: marks visible unread references (mentions) AND
	// advances the group read cursor to the highest message row actually on
	// screen — the atBottom flag lets the owner mark-everything instead, since
	// rows can't see annotations folded into other rows. Skipped while a
	// programmatic scroll flight is mid-air (see settledRun): the transient
	// window may briefly cover the tail during a focus jump.
	function markVisibleUnreadReferences() {
		if (!browser || !container) return;
		if (scrollRun !== settledRun) return;
		const containerRect = container.getBoundingClientRect();
		let maxVisibleCursor = 0;

		for (const virtualItem of virtualItems) {
			// Reads the snapshot — the array the rows were rendered from — never the
			// live prop: mid-update they can disagree and the wrong cursor is read.
			const message = messageSnapshot[virtualItem.index];
			if (!message) continue;
			const element = container.querySelector<HTMLElement>(`[data-index="${virtualItem.index}"]`);
			if (!element) continue;

			const elementRect = element.getBoundingClientRect();
			const isVisible =
				elementRect.top < containerRect.bottom && elementRect.bottom > containerRect.top;
			if (!isVisible) continue;
			const cursor = message.cursor ?? 0;
			if (cursor > maxVisibleCursor) maxVisibleCursor = cursor;
			if (message.systemKind || !message.unreadReference) continue;
			onVisibleUnreadReference(message);
		}

		if (maxVisibleCursor > 0) onVisibleRead({ cursor: maxVisibleCursor, atBottom: wasAtBottom });
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

	function clearFloatingDayTimer() {
		if (floatingDayHideTimer !== null) {
			window.clearTimeout(floatingDayHideTimer);
			floatingDayHideTimer = null;
		}
	}

	function clearFloatingDayRetry() {
		if (floatingDayRetryTimer !== null) {
			window.clearTimeout(floatingDayRetryTimer);
			floatingDayRetryTimer = null;
		}
	}

	function hideFloatingDay() {
		clearFloatingDayTimer();
		clearFloatingDayRetry();
		floatingDayRetries = 0;
		floatingDayScrollDelta = 0;
		floatingDayVisible = false;
	}

	function scheduleFloatingDayRetry(delayMs: number) {
		// A stranded programmatic scroll must not leave an idle retry loop running.
		if (!browser || floatingDayRetries >= FLOATING_DAY_MAX_RETRIES) return;
		floatingDayRetries += 1;
		clearFloatingDayRetry();
		floatingDayRetryTimer = window.setTimeout(() => {
			floatingDayRetryTimer = null;
			scheduleFloatingDayUpdate();
		}, delayMs);
	}

	// The first virtual row whose wrapper still intersects the viewport top.
	// DOM rects are truth here: virtual offsets are estimates for unmeasured rows.
	function topVisibleMessage(): ChatMessage | null {
		if (!container) return null;
		const containerTop = container.getBoundingClientRect().top;
		for (const virtualItem of virtualItems) {
			const message = messageSnapshot[virtualItem.index];
			if (!message) continue;
			const element = container.querySelector<HTMLElement>(`[data-index="${virtualItem.index}"]`);
			if (!element) continue;
			if (element.getBoundingClientRect().bottom > containerTop + 1) return message;
		}
		return null;
	}

	function updateFloatingDay() {
		if (!browser || !container) return;
		// Skip programmatic flights and paging corrections: their transient
		// windows/offsets don't describe what the reader is actually looking at.
		// Retry instead of dropping the pass — the scroll event that revealed the
		// chip is usually the one that also started the page load, so waiting for
		// another event would leave the chip hidden while the reader sits parked.
		if (scrollRun !== settledRun || loadOlderInFlight) {
			scheduleFloatingDayRetry(FLOATING_DAY_RETRY_MS);
			return;
		}
		const suppressionLeft = floatingDaySuppressUntil - performance.now();
		if (suppressionLeft > 0) {
			scheduleFloatingDayRetry(Math.max(suppressionLeft, FLOATING_DAY_RETRY_MS));
			return;
		}
		if (isAtBottom()) {
			hideFloatingDay();
			return;
		}
		const message = topVisibleMessage();
		if (!message) {
			hideFloatingDay();
			return;
		}
		floatingDayLabel = formatChatDayLabel(message.createdAt);
		floatingDayVisible = true;
		clearFloatingDayRetry();
		floatingDayRetries = 0;
		clearFloatingDayTimer();
		floatingDayHideTimer = window.setTimeout(() => {
			floatingDayHideTimer = null;
			floatingDayVisible = false;
		}, FLOATING_DAY_HIDE_MS);
	}

	function scheduleFloatingDayUpdate() {
		if (!browser || floatingDayFrame !== null) return;
		floatingDayFrame = window.requestAnimationFrame(() => {
			floatingDayFrame = null;
			updateFloatingDay();
		});
	}

	function handleScroll() {
		updateBottomState();
		scheduleVisibleUnreadReferenceCheck();
		if (!container) return;
		const top = container.scrollTop;
		const delta = top - lastScrollTop;
		lastScrollTop = top;
		if (performance.now() >= floatingDaySuppressUntil) {
			floatingDayScrollDelta += delta;
			if (floatingDayScrollDelta <= -FLOATING_DAY_DIRECTION_PX) {
				// Moving toward older messages: reveal/advance the day chip.
				floatingDayScrollDelta = 0;
				floatingDayRetries = 0;
				scheduleFloatingDayUpdate();
			} else if (floatingDayScrollDelta >= FLOATING_DAY_DIRECTION_PX) {
				// Moving toward newer messages: the chip slides away immediately.
				hideFloatingDay();
			}
		} else {
			// Compensation moves scrollTop, not the reader: start the next gesture
			// from the corrected position rather than carrying its delta over.
			floatingDayScrollDelta = 0;
		}
		if (top < 240) void handleLoadOlder();
	}

	// Composite message keys are `${eventId}:${cursor}` (raw event ids carry no
	// colon) — the cursor is what pages below the window.
	function parseMessageKeyCursor(messageKey: string): number | undefined {
		const at = messageKey.lastIndexOf(':');
		if (at === -1) return undefined;
		const cursor = Number(messageKey.slice(at + 1));
		return Number.isFinite(cursor) && cursor >= 0 ? cursor : undefined;
	}

	// Scroll-up paging: the anchor math keeps the reading position fixed while
	// rows splice in above. shortcut: exact unless new arrivals land in the same
	// update (their height over-shifts the correction slightly); TanStack's
	// item-size anchoring refines the rest.
	async function handleLoadOlder() {
		if (!onLoadOlder || loadOlderInFlight || historyExhaustedForGroup === groupId) return;
		loadOlderInFlight = true;
		const beforeHeight = container?.scrollHeight ?? 0;
		const beforeTop = container?.scrollTop ?? 0;
		try {
			const loaded = await onLoadOlder();
			await tick();
			if (container) {
				container.scrollTop = beforeTop + (container.scrollHeight - beforeHeight);
				// Compensating for prepended height looks like a downward scroll;
				// don't let it dismiss the chip the reader opened by scrolling up.
				lastScrollTop = container.scrollTop;
				floatingDayScrollDelta = 0;
				floatingDaySuppressUntil = performance.now() + FLOATING_DAY_SUPPRESS_MS;
			}
			measureVisibleItems();
			if (!loaded) historyExhaustedForGroup = groupId;
		} finally {
			loadOlderInFlight = false;
		}
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
			measureElement(element);
		}
	}

	// First-measure vs re-measure (the fold-straddling distinction above) needs
	// the item size cache, which virtual-core 3.15 keeps private — so every row
	// records its key on the first pass through measureElement instead. Both
	// measurement paths (the batch pass and the continuous per-row action below)
	// go through this one wrapper.
	const measuredRowKeys = new Set<string | number | bigint>();
	function measureElement(element: HTMLDivElement) {
		const key = messages[Number(element.dataset.index)]?.id;
		if (key !== undefined) measuredRowKeys.add(key);
		$virtualizer.measureElement(element);
	}

	// Ongoing per-row measurement: the virtualizer's built-in `measureElement`
	// observes each row, so when a row resizes after mount — a media image
	// finishing its async load, or a progress bar appearing — `totalSize` updates.
	// The batch `measureVisibleItems` above is a one-shot; this adds the continuous
	// ResizeObserver that keeps the layout honest post-scroll (one shared RO for
	// all rows, as tanstack ships it).
	function measureItem(node: HTMLDivElement) {
		measureElement(node);
	}

	onMount(() => {
		// Initial positioning (bottom-pin or first-unread focus) is owned by the
		// messages $effect below — it runs on mount too. Here: keep the container
		// shrink observer (soft keyboard) only.

		// Re-pin to the bottom when the scroll container itself shrinks — most importantly the soft
		// keyboard opening on mobile, and the composer growing a line on desktop — so the latest
		// messages stay visible instead of being clipped off the new bottom edge. Guarded by
		// wasAtBottom (never yank someone reading history). The scroll runs synchronously inside the
		// RO callback, which fires before paint in the same rendering update as the resize — a
		// deferred pin left one painted frame sitting off-bottom, and the correction read as the
		// chat "jumping" on every composer line change.
		const ro = new ResizeObserver(() => {
			if (!container || !wasAtBottom || suppressNextAutoScroll) return;
			container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
		});
		if (container) ro.observe(container);
		return () => {
			ro.disconnect();
		};
	});

	$effect(() => {
		const messageCount = messages.length;
		const lastMessageId = messages.at(-1)?.id ?? '';
		const firstMessageId = messages[0]?.id ?? '';
		const focusCursor = initialFocusCursor;
		if (!browser || !container) return;
		if (appliedGroupId !== groupId) {
			hideFloatingDay();
			floatingDayLabel = '';
			floatingDaySuppressUntil = 0;
			lastScrollTop = container.scrollTop;
		}
		// ALWAYS advance the render snapshot, before any gating: rows render from
		// messageSnapshot only, and content-only updates (a reaction chip landing,
		// a peer edit/pin/delete) change no row ids or count — the applied* gate
		// below would hold and freeze the stale snapshot until the next group
		// re-entry. The adapter's setOptions unconditionally notifies the store,
		// so rows repaint even when count/keys/range are identical; scroll and
		// anchor work stays gated. Snapshot+setOptions stay atomic (the prepend
		// franken-DOM fix) and closures still read the snapshot, never the prop.
		untrack(() => {
			messageSnapshot = messages;
			$virtualizer.setOptions({
				count: messageCount,
				getScrollElement: () => container,
				getItemKey: (index) => messageSnapshot[index]?.id ?? index
			});
		});
		// Identity churn from the owner's `messages` derivation must not reach
		// the scroll/read-mark continuation (see the applied* gate above).
		if (
			appliedGroupId === groupId &&
			appliedMessageCount === messageCount &&
			appliedLastMessageId === lastMessageId &&
			appliedFirstMessageId === firstMessageId &&
			appliedFocusCursor === focusCursor
		) {
			return;
		}
		// Older rows merging in ABOVE the viewport (open-time window growth,
		// around-loads) leave scrollTop at the same pixel and slide the view up
		// into old history — the notification-open "lands, then jumps higher"
		// race. Capture the reading anchor before the update; the continuation
		// restores it by row identity through the library's own scroll machinery
		// (restoreAnchorRow) — height-delta arithmetic measured a DOM mid-re-render
		// and overshot.
		const prependAnchor = shouldAnchorPrepend({
			hasAppliedList: appliedMessageCount >= 0,
			firstRowChanged: firstMessageId !== appliedFirstMessageId,
			atBottom: wasAtBottom,
			flightMidAir: scrollRun !== settledRun,
			loadingOlder: loadOlderInFlight,
			suppressed: suppressNextAutoScroll
		})
			? captureAnchorRow()
			: null;
		appliedGroupId = groupId;
		appliedMessageCount = messageCount;
		appliedLastMessageId = lastMessageId;
		appliedFirstMessageId = firstMessageId;
		appliedFocusCursor = focusCursor;

		void tick().then(async () => {
			// Restore the reading anchor first — by row identity, through the
			// virtualizer's own scroll machinery (see restoreAnchorRow) — so the
			// anchor, not the shifted content, defines the position every later
			// actor measures from.
			if (prependAnchor && prependAnchor.id) {
				await restoreAnchorRow(prependAnchor);
			}
			measureVisibleItems();
			if (suppressNextAutoScroll) {
				suppressNextAutoScroll = false;
			} else {
				// Sampled at decision time, not effect-run time: an ingest batch that
				// re-runs this effect mid focus-flight must not bottom-pin over it —
				// the flight has flipped wasAtBottom and owns the scroll by then.
				const shouldScroll = wasAtBottom;
				// Land on the first unread message when the chat opens with one;
				// otherwise keep the classic bottom-pin for new arrivals.
				const focused =
					focusCursor > 0 &&
					focusCursor !== consumedFocusCursor &&
					(await scrollToFocusMessage(focusCursor));
				if (!focused && shouldScroll) await scrollToLatestMessage();
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
		// Run token from entry, with the same exit rule as scrollToFocusMessage:
		// every exit that still owns the token settles it (a stranded scrollRun >
		// settledRun freezes visibility read-marking), and a superseded exit
		// leaves both to its successor.
		const run = ++scrollRun;
		// Accept the raw event id too: reply quotes on pending bubbles and
		// unavailable-parent stubs carry it (no cursor yet), while rendered
		// messages match on their composite `${eventId}:${cursor}` id. Raw ids
		// can't collide with composite ones (no colon).
		let messageIndex = messages.findIndex(
			(message) => message.id === messageId || message.eventId === messageId
		);
		// Windowed history (docs/long-history.md): the target may not be loaded.
		// Composite keys carry the cursor, so load its page and retry; raw event
		// ids can't be resolved below the window (no id index) and no-op as before.
		if (messageIndex === -1 && ensureMessage) {
			const cursor = parseMessageKeyCursor(messageId);
			if (cursor === undefined) {
				settledRun = run; // below-window raw id: nothing to load, settle what we took
				return;
			}
			suppressNextAutoScroll = true;
			await ensureMessage(cursor);
			await tick();
			if (run !== scrollRun) return; // superseded mid-load
			messageIndex = messages.findIndex(
				(message) => message.id === messageId || message.eventId === messageId
			);
			if (messageIndex === -1) {
				suppressNextAutoScroll = false;
				settledRun = run;
				return;
			}
		}
		if (messageIndex === -1) {
			settledRun = run;
			return;
		}
		const targetId = messages[messageIndex].id;

		suppressNextAutoScroll = true;
		const element = await jumpToRow(targetId, 'center', run);
		if (run !== scrollRun) return;
		if (!element) {
			suppressNextAutoScroll = false;
			settledRun = run; // we still own the token — settle or read-marking freezes
			return;
		}

		highlightedMessageId = targetId;
		if (highlightTimeout) {
			clearTimeout(highlightTimeout);
		}
		highlightTimeout = window.setTimeout(() => {
			highlightedMessageId = '';
		}, 2400);

		positionMessage(element, 'center');
		await tick();
		if (run !== scrollRun) return;
		positionMessage(element, 'center');
		updateBottomState();
		// Same rule as scrollToFocusMessage: the flight ends, its suppression
		// ends — never leaked for the next effect run to clean up.
		suppressNextAutoScroll = false;
		settledRun = run;
		markVisibleUnreadReferences();
	}

	$effect(() => {
		return () => {
			if (unreadReferenceFrame !== null) {
				window.cancelAnimationFrame(unreadReferenceFrame);
			}
			if (floatingDayFrame !== null) {
				window.cancelAnimationFrame(floatingDayFrame);
			}
			clearFloatingDayTimer();
			clearFloatingDayRetry();
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
		class="h-full overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none]"
		onscroll={handleScroll}
	>
		<div class="mx-auto min-h-full w-full max-w-5xl px-3 py-4 sm:px-4 sm:py-5 md:px-6 md:py-8">
			<div class="relative w-full" style={`height: ${totalSize}px;`}>
				{#each virtualItems as virtualItem (virtualItem.key)}
					{@const message = messageSnapshot[virtualItem.index]}
					{#if message}
						{@const previousMessage = messageSnapshot[virtualItem.index - 1]}
						{@const nextMessage = messageSnapshot[virtualItem.index + 1]}
						{@const systemRow = Boolean(message.systemKind)}
						{@const runHead = !systemRow && previousMessage?.author !== message.author}
						<!-- Incoming pfp anchors to the NEWEST message of a run (bottom-aligned like Signal):
							the hop to a new tail only mounts an Avatar whose picture prop is already resolved
							and cached (loadedPictures paints it at full opacity instantly), so no fade replays.
							Own messages omit the pfp entirely. -->
						{@const runTail = isRunTail(message, nextMessage)}
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
								{groupId}
								showAuthor={runHead}
								showAvatar={runTail}
								showDayLabel={previousMessage
									? chatDayKey(previousMessage.createdAt) !== chatDayKey(message.createdAt)
									: true}
								showUnreadMarker={message.id === focusMarkerId}
								{onReply}
								{onReact}
								{onUnreact}
								{onEdit}
								{onDelete}
								{onRetrySend}
								{onSendWithoutEmoji}
								onNavigateToMessage={navigateToMessage}
								{onOpenRich}
								{onPin}
								{onVote}
								highlighted={highlightedMessageId === message.id}
							/>
						</div>
					{/if}
				{/each}
			</div>
		</div>
	</div>

	<!-- Floating scroll date: the day of the topmost visible row, like the
	     translucent header in Telegram/WhatsApp. Decorative only — the same day
	     label is still rendered inline between rows. -->
	<div
		class="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-2 transition-opacity duration-200 sm:pt-3"
		class:opacity-0={!floatingDayVisible}
		aria-hidden="true"
	>
		{#if floatingDayLabel}
			<span
				class="rounded-full border border-border/60 bg-background/90 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur"
			>
				{floatingDayLabel}
			</span>
		{/if}
	</div>

	{#if showScrollToBottom || unreadReferenceCount > 0}
		<div class="absolute right-4 bottom-4 z-10 flex flex-col items-end gap-2 md:right-6">
			{#if unreadReferenceCount > 0}
				<Button
					type="button"
					size="icon"
					variant="secondary"
					class="relative h-10 w-10 rounded-full shadow-lg"
					onclick={() => void onNavigateToReference()}
					aria-label="Jump to unread reference"
				>
					<AtSign class="size-4" />
					{#if unreadReferenceCount > 1}
						<span
							class="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
						>
							{unreadReferenceCount}
						</span>
					{/if}
				</Button>
			{/if}
			{#if showScrollToBottom}
				<div transition:scale={{ start: 0.8, duration: 150 }}>
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
	{/if}
</div>
