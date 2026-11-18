<script lang="ts">
	import { toast } from 'svelte-sonner';

	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { calendarEventTarget, type CalendarEventCard } from '$lib/chat/calendar';
	import {
		cancelCalendarEventAction,
		chatComposerActionsStore
	} from '$lib/services/chatUiActions.svelte';

	/**
	 * One confirmation for the event's addressable cancellation, shared by the
	 * event page and the message's actions menu — both surfaces must ask the
	 * same question before a kind-5 reaches the whole group.
	 */
	let {
		open = $bindable(false),
		groupId,
		card = null
	}: { open?: boolean; groupId: string; card?: CalendarEventCard | null } = $props();

	let cancelling = $state(false);

	async function cancelEvent() {
		if (cancelling || !card) return;
		cancelling = true;
		try {
			const sent = await cancelCalendarEventAction(groupId, calendarEventTarget(card));
			if (!sent) {
				toast.error(chatComposerActionsStore.error || 'Failed to cancel event');
				return;
			}
			open = false;
		} finally {
			cancelling = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Cancel this event?</Dialog.Title>
			<Dialog.Description>
				It disappears from the group calendar and the chat card is marked cancelled. Everyone keeps
				their RSVP.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex justify-end gap-2">
			<Button variant="outline" onclick={() => (open = false)}>Keep event</Button>
			<Button variant="destructive" disabled={cancelling} onclick={() => void cancelEvent()}>
				{cancelling ? 'Cancelling…' : 'Cancel event'}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
