<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		validateCalendarEventDraft,
		viewerTimeZone,
		type CalendarEventDraft
	} from '$lib/chat/calendar';

	/**
	 * Calendar event composer (create + revise). One form for both: a revision
	 * keeps the event's `d`, so it replaces the earlier version instead of
	 * posting a second card.
	 *
	 * Date/time entry uses the platform's own pickers (`type="date"`/`time`):
	 * native pickers are the best mobile experience here, and the format is
	 * unambiguous — NN/g's date-input guidance.
	 */
	let {
		open = $bindable(false),
		initial = null,
		defaultDate = '',
		onSave = () => {}
	}: {
		open?: boolean;
		/** Existing event to revise (keeps its identifier). */
		initial?: { d: string; draft: CalendarEventDraft } | null;
		/** `YYYY-MM-DD` to prefill when creating (the calendar's selected day). */
		defaultDate?: string;
		onSave?: (input: { d: string; draft: CalendarEventDraft }) => void;
	} = $props();

	const timeZone = viewerTimeZone();
	const pad = (value: number) => String(value).padStart(2, '0');

	function defaultDraft(): CalendarEventDraft {
		const start = new Date();
		start.setMinutes(0, 0, 0);
		start.setHours(start.getHours() + 1);
		const end = new Date(start.getTime() + 60 * 60 * 1000);
		return {
			title: '',
			description: '',
			location: '',
			link: '',
			image: '',
			allDay: false,
			startDate:
				defaultDate ||
				`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
			endDate: '',
			startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
			endTime: `${pad(end.getHours())}:${pad(end.getMinutes())}`
		};
	}

	let draft = $state<CalendarEventDraft>(defaultDraft());
	let eventId = $state('');

	// bits-ui unmounts the content after the close animation: reset on open, so
	// a second session never inherits the last form (same as the poll composer).
	$effect(() => {
		if (!open) return;
		if (initial) {
			eventId = initial.d;
			draft = { ...initial.draft };
		} else {
			eventId = '';
			draft = defaultDraft();
		}
	});

	const error = $derived(validateCalendarEventDraft(draft, timeZone));

	function handleSave() {
		if (error) return;
		const d = eventId || crypto.randomUUID().replace(/-/g, '');
		onSave({ d, draft });
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="max-h-[90vh] w-[min(calc(100vw-1.5rem),30rem)] overflow-y-auto sm:max-w-lg"
	>
		<Dialog.Header>
			<Dialog.Title>{initial ? 'Edit event' : 'Create event'}</Dialog.Title>
			<Dialog.Description>
				{initial
					? 'Everyone in the group sees the updated details.'
					: 'Events show in the group calendar and in the chat.'}
			</Dialog.Description>
		</Dialog.Header>

		<form
			class="flex flex-col gap-3"
			onsubmit={(event) => {
				event.preventDefault();
				handleSave();
			}}
		>
			<div class="flex flex-col gap-1.5">
				<Label for="event-title">Title</Label>
				<Input id="event-title" bind:value={draft.title} placeholder="Community meetup" />
			</div>

			<div class="flex items-center justify-between gap-3 rounded-xl border px-3 py-2">
				<Label for="event-allday" class="text-sm font-normal">All day</Label>
				<Switch id="event-allday" bind:checked={draft.allDay} disabled={Boolean(initial)} />
			</div>
			{#if initial}
				<p class="-mt-1 text-xs text-muted-foreground">
					An event's type is part of its identity and cannot change when editing.
				</p>
			{/if}

			<div class="flex flex-col gap-1.5">
				<Label for="event-start-date">Starts</Label>
				<div class="grid grid-cols-2 gap-2">
					<Input id="event-start-date" type="date" bind:value={draft.startDate} />
					{#if !draft.allDay}
						<Input type="time" aria-label="Start time" bind:value={draft.startTime} />
					{/if}
				</div>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="event-end">{draft.allDay ? 'Ends (optional)' : 'End time (optional)'}</Label>
				<div class="grid grid-cols-2 gap-2">
					{#if draft.allDay}
						<Input id="event-end" type="date" bind:value={draft.endDate} />
					{:else}
						<Input id="event-end" type="time" aria-label="End time" bind:value={draft.endTime} />
					{/if}
				</div>
				{#if draft.allDay}
					<p class="text-xs text-muted-foreground">
						An end date is exclusive: leaving it empty means a single day.
					</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="event-location">Location (optional)</Label>
				<Input
					id="event-location"
					bind:value={draft.location}
					placeholder="Room 3, or a video link"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="event-link">Link (optional)</Label>
				<Input id="event-link" bind:value={draft.link} placeholder="https://…" inputmode="url" />
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="event-image">Cover image URL (optional)</Label>
				<Input
					id="event-image"
					bind:value={draft.image}
					placeholder="https://…/cover.jpg"
					inputmode="url"
				/>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="event-description">Description (optional)</Label>
				<Textarea id="event-description" bind:value={draft.description} rows={3} />
			</div>

			{#if draft.title.trim() && error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<Button type="submit" disabled={Boolean(error)} class="mt-1 w-full">
				{initial ? 'Save changes' : 'Create event'}
			</Button>
		</form>
	</Dialog.Content>
</Dialog.Root>
