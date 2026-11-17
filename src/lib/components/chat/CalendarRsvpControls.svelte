<script lang="ts">
	import {
		CALENDAR_RSVP_LABELS,
		CALENDAR_RSVP_STATUSES,
		calendarEventTarget,
		type CalendarEventCard,
		type CalendarRsvpStatus
	} from '$lib/chat/calendar';
	import { castCalendarRsvpAction } from '$lib/services/chatUiActions.svelte';
	import { cn } from '$lib/utils';

	/**
	 * The RSVP control shared by the compact chat card, the details body and the
	 * calendar agenda: three pills, one tap, latest answer wins. The pending tap
	 * shows optimistically until the confirmed kind-31925 ingests (multi-device
	 * responses by the same account collapse to one, so stored always wins).
	 */
	let {
		card = null,
		groupId = '',
		isOwn = false
	}: {
		/** Carries the confirmed target and the current tally. Absent for a
		 *  still-queued event bubble — nothing to respond to yet. */
		card?: CalendarEventCard | null;
		groupId?: string;
		isOwn?: boolean;
	} = $props();

	let pendingStatus = $state<CalendarRsvpStatus | null>(null);
	$effect(() => {
		if (pendingStatus && card?.myStatus === pendingStatus) pendingStatus = null;
	});

	const selection = $derived<CalendarRsvpStatus | null>(pendingStatus ?? card?.myStatus ?? null);
	const counts = $derived<Record<CalendarRsvpStatus, number>>({
		accepted: card?.going.length ?? 0,
		tentative: card?.maybe.length ?? 0,
		declined: card?.declined.length ?? 0
	});
	const canRespond = $derived(Boolean(card && !card.cancelled && groupId));

	async function respond(status: CalendarRsvpStatus) {
		if (!card || !canRespond || status === selection) return;
		pendingStatus = status;
		const sent = await castCalendarRsvpAction(groupId, calendarEventTarget(card), status);
		if (!sent && pendingStatus === status) pendingStatus = null;
	}
</script>

<div class="flex flex-wrap gap-1.5">
	{#each CALENDAR_RSVP_STATUSES as status (status)}
		{@const picked = selection === status}
		<button
			type="button"
			disabled={!canRespond}
			onclick={() => void respond(status)}
			aria-pressed={picked}
			aria-label={`${CALENDAR_RSVP_LABELS[status]}${counts[status] > 0 ? ` (${counts[status]})` : ''}${picked ? ', selected' : ''}`}
			class={cn(
				'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
				picked
					? isOwn
						? 'border-primary-foreground/45 bg-primary-foreground/25 text-primary-foreground'
						: 'border-primary/50 bg-primary/15 text-foreground ring-1 ring-primary/30'
					: isOwn
						? 'border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/85 hover:bg-primary-foreground/18'
						: 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
				!canRespond && 'cursor-default opacity-70'
			)}
		>
			<span>{CALENDAR_RSVP_LABELS[status]}</span>
			{#if counts[status] > 0}
				<span class="tabular-nums opacity-80">{counts[status]}</span>
			{/if}
		</button>
	{/each}
</div>
