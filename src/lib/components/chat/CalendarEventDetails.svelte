<script lang="ts">
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import LinkIcon from '@lucide/svelte/icons/link';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { toast } from 'svelte-sonner';

	import { Button } from '$lib/components/ui/button';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import {
		calendarDraftFromDefinition,
		type CalendarEventCard,
		type CalendarEventDraft
	} from '$lib/chat/calendar';
	import { enqueueCalendarEvent } from '$lib/services/chatCalendarActions';
	import { manager } from '$lib/services/accountManager.svelte';
	import { normalizePubKey, samePubKey } from '$lib/utils';
	import CalendarEventCancelDialog from './CalendarEventCancelDialog.svelte';
	import CalendarEventComposerDialog from './CalendarEventComposerDialog.svelte';
	import CalendarRsvpControls from './CalendarRsvpControls.svelte';
	import InlineMediaUrl from './InlineMediaUrl.svelte';
	import { formatCalendarWhenLong } from './calendarDisplay';

	/**
	 * Full-fidelity calendar event body, shared by the detail sidebar, the
	 * dedicated /chat/[id]/e/[eventId] route and the calendar's expanded row —
	 * one presentational component, three containers (README § Rich context).
	 * Unlike the poll body this one is interactive: RSVP is the event's own
	 * workflow, and the author manages revisions here.
	 */
	let { groupId, card }: { groupId: string; card: CalendarEventCard } = $props();

	const activePubkey = $derived.by(() => {
		const pubkey = manager.getActive()?.pubkey;
		return pubkey ? normalizePubKey(pubkey) : '';
	});
	const isAuthor = $derived(Boolean(activePubkey) && samePubKey(card.author, activePubkey));

	let composerOpen = $state(false);
	let cancelOpen = $state(false);

	const initialDraft = $derived({
		d: card.d,
		draft: calendarDraftFromDefinition(card.definition)
	});

	function saveRevision(input: { d: string; draft: CalendarEventDraft }) {
		try {
			enqueueCalendarEvent(groupId, input);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to save event');
		}
	}
</script>

<div class="flex flex-col gap-4 p-4">
	<div class="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
		<CalendarDays class="size-3.5" />
		<span>Calendar event</span>
		{#if card.definition.allDay}
			<span class="rounded-full border border-border px-1.5 py-px text-[10px]">All day</span>
		{/if}
		{#if card.revised}
			<span class="inline-flex items-center" aria-label="Updated" title="Updated">
				<Pencil class="size-3" />
			</span>
		{/if}
		{#if card.cancelled}
			<span
				class="rounded-full border border-destructive/40 px-1.5 py-px text-[10px] text-destructive uppercase"
				>Cancelled</span
			>
		{/if}
	</div>

	<div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
		<span class="shrink-0">By</span>
		<span class="min-w-0">
			<ProfileCard pubkey={card.author} mode="inline" showInlineAvatar={true} profileLink={false} />
		</span>
	</div>

	<div>
		<h2 class="text-lg font-semibold break-words">{card.definition.title}</h2>
		<p class="mt-1 text-sm text-muted-foreground">{formatCalendarWhenLong(card.definition)}</p>
		{#if card.definition.location}
			<p class="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
				<MapPin class="size-3.5 shrink-0" />
				<span class="break-words">{card.definition.location}</span>
			</p>
		{/if}
	</div>

	{#if card.definition.image}
		<InlineMediaUrl href={card.definition.image} />
	{/if}

	{#if card.definition.description}
		<div class="text-sm break-words whitespace-pre-wrap">
			<MessageParts messageId={card.id} text={card.definition.description} />
		</div>
	{/if}

	{#if card.definition.links.length > 0}
		<div class="flex flex-col gap-1">
			{#each card.definition.links as link (link)}
				<a
					href={link}
					target="_blank"
					rel="external noreferrer noopener"
					class="flex items-center gap-1.5 text-sm break-all text-primary hover:underline"
				>
					<LinkIcon class="size-3.5 shrink-0" />
					{link}
				</a>
			{/each}
		</div>
	{/if}

	{#if card.cancelled}
		<p
			class="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
		>
			This event was cancelled by its author.
		</p>
	{:else}
		<div class="flex flex-col gap-2">
			<CalendarRsvpControls {card} {groupId} />
			{#each [{ label: 'Going', people: card.going }, { label: 'Maybe', people: card.maybe }, { label: "Can't go", people: card.declined }] as bucket (bucket.label)}
				{#if bucket.people.length > 0}
					<div class="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
						<p class="text-xs font-medium text-muted-foreground">
							{bucket.label} · {bucket.people.length}
						</p>
						<div class="mt-1.5 flex flex-wrap gap-1.5">
							{#each bucket.people as attendee (attendee.pubkey)}
								<span
									class="inline-flex min-w-0 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-2 py-1"
								>
									<ProfileCard
										pubkey={attendee.pubkey}
										mode="inline"
										showInlineAvatar={true}
										profileLink={false}
									/>
								</span>
							{/each}
						</div>
					</div>
				{/if}
			{/each}
		</div>
	{/if}

	{#if isAuthor && !card.cancelled}
		<div class="flex flex-wrap gap-2 border-t border-border/70 pt-3">
			<Button variant="outline" size="sm" onclick={() => (composerOpen = true)}>
				<Pencil class="size-3.5" />
				Edit event
			</Button>
			<Button variant="destructive" size="sm" onclick={() => (cancelOpen = true)}>
				<Trash2 class="size-3.5" />
				Cancel event
			</Button>
		</div>
	{/if}
</div>

<CalendarEventComposerDialog
	bind:open={composerOpen}
	initial={initialDraft}
	onSave={saveRevision}
/>

<CalendarEventCancelDialog bind:open={cancelOpen} {groupId} {card} />
