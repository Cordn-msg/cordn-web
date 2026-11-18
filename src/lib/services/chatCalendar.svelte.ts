/**
 * Group calendar read model. The chat store holds a bounded window
 * (docs/long-history.md), so a month view cannot be derived from it: this
 * module keeps one on-demand, kind-scoped durable read per group and merges it
 * with the live window, so old events stay visible and new RSVPs land
 * instantly. No coordinator fetch, no second watch driver — the calendar is a
 * projection of messages the group already has.
 */
import { errorMessage, normalizePubKey } from '$lib/utils';
import {
	CALENDAR_MESSAGE_KINDS,
	buildCalendarProjection,
	findCalendarEvent,
	viewerTimeZone,
	type CalendarEventCard
} from '$lib/chat/calendar';
import { getChatStorage } from '$lib/storage/chatStorage';
import { listChatGroupMessages } from '$lib/services/chatGroups.svelte';
import { manager } from '$lib/services/accountManager.svelte';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

interface CalendarSnapshot {
	rows: StoredChatMessage[];
	loaded: boolean;
	loading: boolean;
	error: string;
}

const EMPTY_SNAPSHOT: CalendarSnapshot = { rows: [], loaded: false, loading: false, error: '' };

const snapshots = $state<Record<string, CalendarSnapshot>>({});
const inFlight = new Map<string, Promise<void>>();

export function calendarSnapshot(groupId: string): CalendarSnapshot {
	return snapshots[groupId] ?? EMPTY_SNAPSHOT;
}

/** Loads the group's durable calendar rows once. `force` re-reads (the calendar
 *  view does this when the group advances, so a revision that arrived and then
 *  fell out of the window can never be shadowed by a stale snapshot). */
export async function loadGroupCalendar(
	groupId: string,
	options: { force?: boolean } = {}
): Promise<void> {
	const pending = inFlight.get(groupId);
	if (pending) return pending;
	if (!options.force && snapshots[groupId]?.loaded) return;

	const promise = (async () => {
		snapshots[groupId] = { ...calendarSnapshot(groupId), loading: true, error: '' };
		try {
			const storage = await getChatStorage();
			const rows = await storage.getGroupMessagesByKinds(groupId, CALENDAR_MESSAGE_KINDS);
			snapshots[groupId] = { rows, loaded: true, loading: false, error: '' };
		} catch (error) {
			snapshots[groupId] = {
				...calendarSnapshot(groupId),
				loading: false,
				error: errorMessage(error)
			};
		} finally {
			inFlight.delete(groupId);
		}
	})();
	inFlight.set(groupId, promise);
	return promise;
}

/** Durable rows ∪ the live window's calendar rows, deduped by cursor. */
function mergeCalendarRows(
	stored: StoredChatMessage[],
	window: StoredChatMessage[]
): StoredChatMessage[] {
	const byCursor = new Map<number, StoredChatMessage>();
	for (const message of stored) byCursor.set(message.cursor, message);
	for (const message of window) {
		if (CALENDAR_MESSAGE_KINDS.includes(message.kind)) byCursor.set(message.cursor, message);
	}
	return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
}

interface ProjectionCache {
	snapshot: StoredChatMessage[];
	window: StoredChatMessage[];
	me: string;
	timeZone: string;
	cards: CalendarEventCard[];
}

const projectionCache = new Map<string, ProjectionCache>();

/** The group's event cards. Memoized on the two row arrays' identity, so a
 *  virtualized list of event cards pays one projection per store change. */
export function groupCalendarCards(groupId: string): CalendarEventCard[] {
	const snapshot = calendarSnapshot(groupId).rows;
	const window = listChatGroupMessages(groupId);
	const active = manager.getActive()?.pubkey;
	const me = active ? normalizePubKey(active) : '';
	const timeZone = viewerTimeZone();

	const cached = projectionCache.get(groupId);
	if (
		cached &&
		cached.snapshot === snapshot &&
		cached.window === window &&
		cached.me === me &&
		cached.timeZone === timeZone
	) {
		return cached.cards;
	}

	const cards = buildCalendarProjection(mergeCalendarRows(snapshot, window), {
		myPubkey: me,
		timeZone
	});
	projectionCache.set(groupId, { snapshot, window, me, timeZone, cards });
	return cards;
}

/** The card an event id (any revision) belongs to. */
export function groupCalendarEvent(groupId: string, eventId: string): CalendarEventCard | null {
	return findCalendarEvent(groupCalendarCards(groupId), eventId);
}
