<script lang="ts">
	import { richBodies, defaultRichBody, type RichBodyProps } from '$lib/chat/registry';
	import { listChatGroupMessages } from '$lib/services/chatGroups.svelte';
	import { groupCalendarEvent, loadGroupCalendar } from '$lib/services/chatCalendar.svelte';

	let { groupId, eventId, onNavigate, onJumpToMessage }: RichBodyProps = $props();

	const subject = $derived(
		listChatGroupMessages(groupId).find((message) => message.id === eventId)
	);
	// Addressable calendar events resolve through the projection, not the
	// windowed store: a permalink to an event older than the loaded window (or
	// to an earlier revision) must still open its latest card.
	const calendarCard = $derived(groupCalendarEvent(groupId, eventId));
	const kind = $derived(subject?.kind ?? calendarCard?.kind);
	const Body = $derived(kind ? (richBodies[kind] ?? defaultRichBody) : null);

	$effect(() => {
		if (!subject) void loadGroupCalendar(groupId);
	});
</script>

{#if Body}
	<Body {groupId} {eventId} {onNavigate} {onJumpToMessage} />
{:else}
	<div class="p-6 text-sm text-muted-foreground">This message is no longer available.</div>
{/if}
