<script lang="ts">
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Pencil from '@lucide/svelte/icons/pencil';

	import type { CalendarEventCard, CalendarEventDefinition } from '$lib/chat/calendar';
	import CalendarRsvpControls from './CalendarRsvpControls.svelte';
	import InlineMediaUrl from './InlineMediaUrl.svelte';
	import { formatCalendarAttendance, formatCalendarWhen } from './calendarDisplay';
	import { cn } from '$lib/utils';

	/**
	 * Compact calendar event card: date badge, title, one-line "when", location
	 * and the RSVP controls. Used by the chat stream row; the calendar agenda
	 * has its own denser row, and the expanded view lives in
	 * CalendarEventDetails.
	 */
	let {
		definition,
		card = null,
		isOwn = false,
		groupId = '',
		onOpen
	}: {
		definition: CalendarEventDefinition;
		/** The projected card: carries the confirmed target and RSVP tally.
		 *  Absent for a still-queued event bubble (nothing to respond to yet). */
		card?: CalendarEventCard | null;
		isOwn?: boolean;
		groupId?: string;
		onOpen?: () => void;
	} = $props();

	const month = $derived(
		new Date(definition.start * 1000)
			.toLocaleDateString(undefined, {
				month: 'short',
				timeZone: definition.allDay ? 'UTC' : undefined
			})
			.toLocaleUpperCase()
	);
	// All-day events are UTC-midnight based; timed events show the viewer's local day.
	const dayNumber = $derived(
		definition.allDay
			? Number(definition.startDate.slice(8, 10))
			: new Date(definition.start * 1000).getDate()
	);
</script>

<div
	class={cn(
		'mt-1 w-full max-w-md rounded-2xl border p-3',
		isOwn ? 'border-primary-foreground/25 bg-primary-foreground/12' : 'border-border/70 bg-card/60'
	)}
>
	{#if definition.image}
		<!-- Cover image: same auto-load gate as pasted media, bounded to keep the
		     compact card compact. -->
		<div class="mt-2 overflow-hidden rounded-xl [&_img]:max-h-36">
			<InlineMediaUrl href={definition.image} {isOwn} eager />
		</div>
	{/if}

	<div class="flex items-start gap-3">
		<div
			class={cn(
				'flex size-11 shrink-0 flex-col items-center justify-center rounded-xl border leading-none',
				isOwn
					? 'border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground'
					: 'border-border/70 bg-background text-foreground'
			)}
			aria-hidden="true"
		>
			<span class="text-[9px] font-semibold tracking-wide">{month}</span>
			<span class="text-base font-bold tabular-nums">{dayNumber}</span>
		</div>

		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-1.5">
				<span
					class={cn(
						'text-[10px] font-medium tracking-wide uppercase',
						isOwn ? 'text-primary-foreground/70' : 'text-muted-foreground'
					)}
				>
					Event
				</span>
				{#if definition.allDay}
					<span
						class={cn(
							'rounded-full border px-1.5 py-px text-[10px]',
							isOwn ? 'border-primary-foreground/30' : 'border-border'
						)}>All day</span
					>
				{/if}
				{#if card?.revised}
					<span
						class={cn(
							'inline-flex items-center',
							isOwn ? 'text-primary-foreground/70' : 'text-muted-foreground'
						)}
						aria-label="Updated"
						title="Updated"
					>
						<Pencil class="size-3" />
					</span>
				{/if}
				{#if card?.cancelled}
					<span
						class={cn(
							'rounded-full border px-1.5 py-px text-[10px] uppercase',
							isOwn ? 'border-primary-foreground/30' : 'border-destructive/40 text-destructive'
						)}>Cancelled</span
					>
				{/if}
			</div>

			{#if onOpen}
				<button
					type="button"
					class={cn(
						'mt-0.5 block w-full min-w-0 text-left text-sm font-semibold break-words transition-opacity hover:opacity-80',
						isOwn && 'text-primary-foreground'
					)}
					onclick={onOpen}
				>
					{definition.title}
				</button>
			{:else}
				<p
					class={cn('mt-0.5 text-sm font-semibold break-words', isOwn && 'text-primary-foreground')}
				>
					{definition.title}
				</p>
			{/if}

			<p
				class={cn('mt-0.5 text-xs', isOwn ? 'text-primary-foreground/80' : 'text-muted-foreground')}
			>
				{formatCalendarWhen(definition)}
			</p>

			{#if definition.location}
				<p
					class={cn(
						'mt-1 flex items-center gap-1 text-xs',
						isOwn ? 'text-primary-foreground/80' : 'text-muted-foreground'
					)}
				>
					<MapPin class="size-3 shrink-0" />
					<span class="truncate">{definition.location}</span>
				</p>
			{/if}
		</div>
	</div>

	{#if card && !card.cancelled}
		<p class={cn('mt-2 text-xs', isOwn ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
			{formatCalendarAttendance(card)}
		</p>
	{/if}

	{#if !card?.cancelled}
		<div class="mt-2">
			<CalendarRsvpControls {card} {groupId} {isOwn} />
		</div>
	{/if}
</div>
