<script lang="ts">
	import CalendarEventChip from '$lib/components/chat/CalendarEventChip.svelte';
	import { getCalendarEventDefinition } from '$lib/chat/calendar';
	import type { InlineBodyProps } from '$lib/chat/registry';
	import { groupCalendarEvent, loadGroupCalendar } from '$lib/services/chatCalendar.svelte';
	import { cn } from '$lib/utils';

	/**
	 * Compact calendar event card (kind 31922/31923) for the chat stream. RSVPs
	 * are this kind's sparse aggregate — self-queried through the group
	 * calendar projection (README § Dense vs sparse), never folded by the shell.
	 */
	let { message, groupId = '', onOpenRich }: InlineBodyProps = $props();

	const card = $derived(groupId ? groupCalendarEvent(groupId, message.eventId) : null);
	// A queued bubble carries an `outbox:` id and has no projection entry yet:
	// parse its own tags so the card still renders (RSVP stays disabled until
	// the confirmed row exists).
	const definition = $derived(
		card?.definition ?? getCalendarEventDefinition(message.kind, message.text, message.tags ?? [])
	);
	// The tally may include RSVPs older than the loaded chat window; one
	// kind-scoped read per group per session, after which the live window keeps
	// it current.
	$effect(() => {
		if (groupId) void loadGroupCalendar(groupId);
	});
</script>

{#if !definition}
	<div
		class={cn(
			'rounded-2xl border border-dashed px-3 py-2 text-sm text-muted-foreground italic',
			(message.isOwn ?? false) && 'border-primary-foreground/25 text-primary-foreground/80'
		)}
	>
		Unsupported calendar event
	</div>
{:else}
	<CalendarEventChip
		{definition}
		{card}
		{groupId}
		messageId={message.id}
		isOwn={message.isOwn ?? false}
		onOpen={card && onOpenRich ? () => onOpenRich(card.id) : undefined}
	/>
{/if}
