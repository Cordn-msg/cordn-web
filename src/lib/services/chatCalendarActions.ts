/**
 * Calendar send helpers. Event creation is a durable, outbox-first intent (like
 * a poll): persisted before any network attempt, drained per group, and
 * optimistic in the chat stream. Kept out of chatUiActions so that module's
 * import graph stays free of the outbox (its unit test mocks the account
 * manager).
 */
import {
	createCalendarEventMessage,
	viewerTimeZone,
	type CalendarEventDraft
} from '$lib/chat/calendar';
import { enqueueTextMessage } from '$lib/services/chatOutboxQueue';

/** Create (or revise) a calendar event. Throws on an invalid draft — the
 *  composer validates first, so callers surface the message. */
export function enqueueCalendarEvent(
	groupId: string,
	input: { d: string; draft: CalendarEventDraft; timeZone?: string }
): void {
	const { kind, content, tags } = createCalendarEventMessage({
		...input,
		timeZone: input.timeZone ?? viewerTimeZone()
	});
	enqueueTextMessage({ groupId, content, tags, kind });
}
