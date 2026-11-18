<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Calendar } from 'bits-ui';
	import {
		CalendarDate,
		getLocalTimeZone,
		parseDate,
		startOfWeek,
		today
	} from '@internationalized/date';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import { tick, untrack } from 'svelte';

	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import type { CalendarEventCard, CalendarEventDraft } from '$lib/chat/calendar';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { getChatGroup } from '$lib/services/chatGroups.svelte';
	import {
		calendarSnapshot,
		groupCalendarCards,
		loadGroupCalendar
	} from '$lib/services/chatCalendar.svelte';
	import { enqueueCalendarEvent } from '$lib/services/chatCalendarActions';
	import { cn } from '$lib/utils';
	import CalendarEventAuthor from './CalendarEventAuthor.svelte';
	import CalendarEventComposerDialog from './CalendarEventComposerDialog.svelte';
	import CalendarEventDetails from './CalendarEventDetails.svelte';
	import CalendarRsvpControls from './CalendarRsvpControls.svelte';
	import {
		formatCalendarAttendance,
		formatCalendarDayLong,
		formatCalendarTime
	} from './calendarDisplay';

	/**
	 * The group's month / week / day calendar. Data comes from the durable
	 * kind-scoped read merged with the live chat window (chatCalendar), never
	 * from a full-history scan and never from a second coordinator fetch.
	 *
	 * Tapping an event expands its details in place: from the calendar the event
	 * is the subject, so navigating to the message route would lose the day you
	 * were looking at.
	 */
	let { groupId }: { groupId: string } = $props();

	type View = 'month' | 'week' | 'day';

	const todayValue = today(getLocalTimeZone());
	const initialView = page.url.searchParams.get('cal-view');
	const initialDay = page.url.searchParams.get('cal-day');
	function parseCalendarDate(value: string | null): CalendarDate | null {
		if (!value) return null;
		try {
			return parseDate(value);
		} catch {
			return null;
		}
	}

	const initialSelected = parseCalendarDate(initialDay) ?? todayValue;
	let view = $state<View>(initialView === 'week' || initialView === 'day' ? initialView : 'month');
	let selected = $state<CalendarDate>(initialSelected);
	let placeholder = $state<CalendarDate>(initialSelected);
	let expanded = $state('');
	let composerOpen = $state(false);

	const group = $derived(getChatGroup(groupId));
	const snapshot = $derived(calendarSnapshot(groupId));
	const cards = $derived(groupCalendarCards(groupId));

	// Re-read the durable rows whenever the group advances, so a revision that
	// arrived and then fell out of the chat window can never be shadowed by a
	// stale snapshot. Kind-scoped index read: cost tracks calendar rows, not history.
	$effect(() => {
		void group?.lastCursor;
		untrack(() => void loadGroupCalendar(groupId, { force: true }));
	});

	const activeCards = $derived(cards.filter((card) => !card.cancelled));

	const eventsByDay = $derived.by(() => {
		const map = new Map<string, CalendarEventCard[]>();
		for (const card of activeCards) {
			for (const key of card.dayKeys) {
				const list = map.get(key) ?? [];
				list.push(card);
				map.set(key, list);
			}
		}
		return map;
	});

	const weekDays = $derived.by(() => {
		const locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language || 'en-US';
		const start = startOfWeek(selected, locale);
		return Array.from({ length: 7 }, (_, index) => start.add({ days: index }));
	});

	const rangeDays = $derived(
		view === 'week' ? weekDays.map((day) => day.toString()) : [selected.toString()]
	);

	const selectedKey = $derived(selected.toString());
	const todayKey = $derived(todayValue.toString());
	// Never show a no-op Today: hide it when the current range already is today.
	const showTodayButton = $derived(
		view === 'week'
			? !weekDays.some((day) => day.toString() === todayKey)
			: selectedKey !== todayKey
	);
	const routeId = $derived(groupRouteId(groupId));
	const detailSearch = $derived.by(() => {
		const params = new URLSearchParams(page.url.search);
		params.set('from', 'cal');
		params.set('cal-view', view);
		params.set('cal-day', selectedKey);
		return params.toString();
	});
	const rangeHasEvents = $derived(
		rangeDays.some((dayKey) => (eventsByDay.get(dayKey)?.length ?? 0) > 0)
	);

	function detailHref(eventId: string): string {
		return `${resolve('/chat/[id]/e/[eventId]', { id: routeId, eventId })}?${detailSearch}`;
	}

	async function goToday() {
		selected = todayValue;
		placeholder = todayValue;
		await tick();
		document
			.querySelector(`[data-calendar-day="${todayValue.toString()}"]`)
			?.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}

	function saveEvent(input: { d: string; draft: CalendarEventDraft }) {
		enqueueCalendarEvent(groupId, input);
	}

	function toggle(coordinate: string) {
		expanded = expanded === coordinate ? '' : coordinate;
	}

	const views: Array<{ key: View; label: string }> = [
		{ key: 'month', label: 'Month' },
		{ key: 'week', label: 'Week' },
		{ key: 'day', label: 'Day' }
	];
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<div
		class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2 md:px-6"
	>
		<div class="flex items-center gap-1" role="group" aria-label="Calendar range">
			{#each views as item (item.key)}
				<button
					type="button"
					aria-pressed={view === item.key}
					onclick={() => (view = item.key)}
					class={cn(
						'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
						view === item.key
							? 'bg-muted text-foreground'
							: 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
					)}
				>
					{item.label}
				</button>
			{/each}
		</div>
		<div class="flex items-center gap-1">
			{#if showTodayButton}
				<Button variant="ghost" size="sm" onclick={() => void goToday()}>Today</Button>
			{/if}
			<Button size="sm" onclick={() => (composerOpen = true)}>
				<Plus class="size-3.5" />
				Event
			</Button>
		</div>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto pb-inset">
		<div class="mx-auto w-full max-w-2xl px-3 py-3 md:px-6">
			{#if view === 'month'}
				<Calendar.Root
					type="single"
					bind:value={selected}
					bind:placeholder
					preventDeselect
					weekdayFormat="short"
					class="w-full rounded-2xl border border-border/70 bg-card/40 p-2 select-none"
				>
					{#snippet children({ months, weekdays })}
						<Calendar.Header class="flex items-center justify-between px-1 pb-1">
							<Calendar.PrevButton
								class="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<span aria-hidden="true">‹</span>
								<span class="sr-only">Previous month</span>
							</Calendar.PrevButton>
							<Calendar.Heading class="text-sm font-semibold" />
							<Calendar.NextButton
								class="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<span aria-hidden="true">›</span>
								<span class="sr-only">Next month</span>
							</Calendar.NextButton>
						</Calendar.Header>
						{#each months as month (month.value.toString())}
							<Calendar.Grid class="w-full border-collapse">
								<Calendar.GridHead>
									<Calendar.GridRow class="flex w-full">
										{#each weekdays as weekday, index (index)}
											<Calendar.HeadCell
												class="flex-1 pb-1 text-center text-[11px] font-medium text-muted-foreground"
											>
												{weekday}
											</Calendar.HeadCell>
										{/each}
									</Calendar.GridRow>
								</Calendar.GridHead>
								<Calendar.GridBody>
									{#each month.weeks as week (week.toString())}
										<Calendar.GridRow class="mt-0.5 flex w-full">
											{#each week as date (date.toString())}
												{@const key = date.toString()}
												{@const count = eventsByDay.get(key)?.length ?? 0}
												<Calendar.Cell {date} month={month.value} class="flex-1 p-0.5">
													<Calendar.Day
														class={cn(
															'flex min-h-9 w-full flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1 text-xs transition-colors',
															selected.toString() === key
																? 'bg-primary font-semibold text-primary-foreground'
																: 'hover:bg-muted',
															key === todayKey &&
																selected.toString() !== key &&
																'ring-1 ring-primary/40'
														)}
													>
														{#snippet children({ selected: isSelected })}
															<span>{date.day}</span>
															{#if count > 0}
																<span class="flex items-center gap-0.5" aria-hidden="true">
																	{#each Array.from({ length: Math.min(count, 3) }) as _, dot (dot)}
																		<span
																			class={cn(
																				'size-1 rounded-full',
																				isSelected ? 'bg-primary-foreground' : 'bg-primary'
																			)}
																		></span>
																	{/each}
																</span>
																<span class="sr-only">
																	{count}
																	{count === 1 ? 'event' : 'events'}
																</span>
															{/if}
														{/snippet}
													</Calendar.Day>
												</Calendar.Cell>
											{/each}
										</Calendar.GridRow>
									{/each}
								</Calendar.GridBody>
							</Calendar.Grid>
						{/each}
					{/snippet}
				</Calendar.Root>
			{/if}

			{#if snapshot.loading && !snapshot.loaded}
				<div class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
					<Spinner class="size-4" />
					Loading events…
				</div>
			{:else if snapshot.error}
				<p class="py-4 text-sm text-destructive">{snapshot.error}</p>
			{/if}

			{#if activeCards.length > 0}
				<div class="mt-3 flex flex-col gap-4">
					{#if view === 'week' && !rangeHasEvents}
						<p class="px-1 text-sm text-muted-foreground">No events this week.</p>
					{/if}
					{#each rangeDays as dayKey (dayKey)}
						{@const dayEvents = eventsByDay.get(dayKey) ?? []}
						<section data-calendar-day={dayKey}>
							<h2
								class={cn(
									'px-1 text-xs tracking-wide uppercase',
									dayKey === todayKey
										? 'font-bold text-foreground'
										: 'font-semibold text-muted-foreground'
								)}
							>
								{formatCalendarDayLong(dayKey)}
							</h2>
							{#if dayEvents.length > 0}
								<div class="mt-1 flex flex-col gap-2">
									{#each dayEvents as card (card.coordinate)}
										<div class="overflow-hidden rounded-2xl border border-border/70 bg-card/50">
											<div class="flex items-center">
												<button
													type="button"
													class="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
													aria-expanded={expanded === card.coordinate}
													onclick={() => toggle(card.coordinate)}
												>
													<span class="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">
														{card.definition.allDay
															? 'All day'
															: formatCalendarTime(card.definition)}
													</span>
													<span class="min-w-0 flex-1">
														<span class="flex min-w-0 items-center gap-1">
															<span class="block truncate text-sm font-medium"
																>{card.definition.title}</span
															>
															{#if card.revised}
																<span
																	class="inline-flex shrink-0 items-center text-muted-foreground"
																	aria-label="Edited"
																	title="Edited"
																>
																	<Pencil class="size-3" />
																</span>
															{/if}
														</span>
														<span
															class="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
														>
															<CalendarEventAuthor pubkey={card.author} />
															<span class="shrink-0">· {formatCalendarAttendance(card)}</span>
														</span>
													</span>
												</button>
												<Button
													href={detailHref(card.id)}
													variant="ghost"
													size="icon-sm"
													class="mr-2 shrink-0"
													aria-label="Open event details"
													title="Open details"
												>
													<ArrowUpRight class="size-4" />
												</Button>
											</div>
											{#if expanded === card.coordinate}
												<div class="border-t border-border/70">
													<CalendarEventDetails {groupId} {card} />
												</div>
											{:else if card.myStatus === null}
												<div class="border-t border-border/70 px-3 py-2">
													<CalendarRsvpControls {card} {groupId} />
												</div>
											{/if}
										</div>
									{/each}
								</div>
							{:else if view === 'day'}
								<p class="px-1 py-2 text-sm text-muted-foreground">No events today.</p>
							{/if}
						</section>
					{/each}
				</div>
			{/if}

			{#if activeCards.length === 0 && !snapshot.loading}
				<div
					class="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-dashed px-4 py-8 text-center"
				>
					<CalendarDays class="size-6 text-muted-foreground" aria-hidden="true" />
					<p class="text-sm text-muted-foreground">
						No events in this group yet. Create one and everyone can see it here.
					</p>
					<Button size="sm" onclick={() => (composerOpen = true)}>
						<Plus class="size-3.5" />
						Create event
					</Button>
				</div>
			{/if}
		</div>
	</div>
</div>

<CalendarEventComposerDialog
	bind:open={composerOpen}
	defaultDate={selectedKey}
	onSave={saveEvent}
/>
