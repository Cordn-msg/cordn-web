<script lang="ts">
	import CalendarEventDetails from '$lib/components/chat/CalendarEventDetails.svelte';
	import type { RichBodyProps } from '$lib/chat/registry';
	import { groupCalendarEvent, loadGroupCalendar } from '$lib/services/chatCalendar.svelte';

	/**
	 * Full-fidelity calendar event view (kind 31922/31923) shared by the detail
	 * sidebar, /chat/[id]/e/[eventId] and the calendar's expanded row. Resolves
	 * through the group projection, so RSVP counts and revisions stay live.
	 */
	let { groupId, eventId }: RichBodyProps = $props();

	const card = $derived(groupCalendarEvent(groupId, eventId));

	// Deep links land before the durable rows load: the projection fills in.
	$effect(() => {
		void loadGroupCalendar(groupId);
	});
</script>

{#if card}
	<CalendarEventDetails {groupId} {card} />
{:else}
	<div class="p-6 text-sm text-muted-foreground italic">This event is no longer available.</div>
{/if}
