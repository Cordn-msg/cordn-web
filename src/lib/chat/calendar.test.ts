import { describe, expect, it } from 'vitest';

import { ChatKinds } from '$lib/chat/kinds';
import {
	buildCalendarProjection,
	calendarDraftFromDefinition,
	calendarEventDayKeys,
	createCalendarCancelTags,
	createCalendarEventMessage,
	createCalendarRsvpTags,
	findCalendarEvent,
	getCalendarEventDefinition,
	getCalendarRsvpReference,
	validateCalendarEventDraft,
	type CalendarEventDraft
} from '$lib/chat/calendar';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const ME = 'c'.repeat(64);
const TZ = 'Europe/Madrid';

function draft(overrides: Partial<CalendarEventDraft> = {}): CalendarEventDraft {
	return {
		title: 'Planning call',
		description: 'Bring the roadmap',
		location: 'Room 3',
		link: '',
		image: '',
		allDay: false,
		startDate: '2026-11-20',
		endDate: '',
		startTime: '18:00',
		endTime: '19:30',
		...overrides
	};
}

function message(id: string, overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
	return {
		cursor: 1,
		createdAt: Date.UTC(2026, 10, 19),
		direction: 'inbound',
		sender: ALICE,
		id,
		kind: ChatKinds.Text,
		tags: [],
		content: '',
		...overrides
	};
}

function eventMessage(
	id: string,
	input: {
		d?: string;
		sender?: string;
		draft?: Partial<CalendarEventDraft>;
		eventCreatedAt?: number;
		cursor?: number;
		description?: string;
	} = {}
): StoredChatMessage {
	const built = createCalendarEventMessage({
		d: input.d ?? 'event-1',
		draft: draft(input.draft),
		timeZone: TZ
	});
	return message(id, {
		kind: built.kind,
		tags: built.tags,
		content: input.description ?? built.content,
		sender: input.sender ?? ALICE,
		cursor: input.cursor ?? 1,
		eventCreatedAt: input.eventCreatedAt ?? 1_760_000_000,
		createdAt: (input.eventCreatedAt ?? 1_760_000_000) * 1000
	});
}

describe('calendar drafts', () => {
	it('accepts a valid timed draft and rejects broken ones', () => {
		expect(validateCalendarEventDraft(draft(), TZ)).toBeNull();
		expect(validateCalendarEventDraft(draft({ title: ' ' }), TZ)).toMatch(/Title/);
		// Surrounding whitespace is normalized, not rejected.
		expect(validateCalendarEventDraft(draft({ title: ' pad ' }), TZ)).toBeNull();
		expect(validateCalendarEventDraft(draft({ title: 'a\u202eb' }), TZ)).toMatch(/Title/);
		expect(validateCalendarEventDraft(draft({ startDate: '2026-02-30' }), TZ)).toMatch(/date/);
		expect(validateCalendarEventDraft(draft({ startTime: '25:00' }), TZ)).toMatch(/date and time/);
		expect(validateCalendarEventDraft(draft({ startTime: '19:00', endTime: '18:00' }), TZ)).toMatch(
			/end time/
		);
		expect(validateCalendarEventDraft(draft({ startTime: '19:00', endTime: '19:00' }), TZ)).toMatch(
			/end time/
		);
		expect(validateCalendarEventDraft(draft({ link: 'javascript:alert(1)' }), TZ)).toMatch(/Link/);
		expect(validateCalendarEventDraft(draft({ image: 'data:image/png;base64,xx' }), TZ)).toMatch(
			/Cover image/
		);
		expect(validateCalendarEventDraft(draft(), 'Not/AZone')).toMatch(/time zone/);
	});

	it('accepts long text without field-size caps', () => {
		const longTitle = 'T'.repeat(600);
		const longDescription = 'D'.repeat(20_000);
		const longLocation = 'L'.repeat(2_000);
		const long = draft({ title: longTitle, description: longDescription, location: longLocation });
		expect(validateCalendarEventDraft(long, TZ)).toBeNull();

		const built = createCalendarEventMessage({ d: 'long', draft: long, timeZone: TZ });
		const parsed = getCalendarEventDefinition(built.kind, built.content, built.tags);
		expect(parsed?.title).toBe(longTitle);
		expect(parsed?.description).toBe(longDescription);
		expect(parsed?.location).toBe(longLocation);
	});

	it('rejects an all-day range whose end is not after the start', () => {
		const allDay = draft({ allDay: true, startDate: '2026-11-20', endDate: '2026-11-20' });
		expect(validateCalendarEventDraft(allDay, TZ)).toMatch(/end date/);
		expect(validateCalendarEventDraft({ ...allDay, endDate: '2026-11-22' }, TZ)).toBeNull();
	});
});

describe('calendar tag round trip', () => {
	it('builds a timed event with the timezone and day indexes', () => {
		const built = createCalendarEventMessage({ d: 'abc', draft: draft(), timeZone: TZ });
		expect(built.kind).toBe(ChatKinds.CalendarTime);
		expect(built.content).toBe('Bring the roadmap');
		expect(built.tags).toContainEqual(['d', 'abc']);
		expect(built.tags).toContainEqual(['title', 'Planning call']);
		expect(built.tags).toContainEqual(['start_tzid', TZ]);
		expect(built.tags.filter((tag) => tag[0] === 'D')).toHaveLength(1);
		expect(built.tags.at(-1)).toEqual(['alt', 'Calendar event: Planning call']);

		const parsed = getCalendarEventDefinition(built.kind, built.content, built.tags);
		expect(parsed).toMatchObject({
			d: 'abc',
			allDay: false,
			title: 'Planning call',
			description: 'Bring the roadmap',
			location: 'Room 3',
			startTzid: TZ,
			endTzid: TZ
		});
		expect(parsed!.end).toBeGreaterThan(parsed!.start);
	});

	it('carries NIP-31 alt fallbacks on RSVPs and cancellations', () => {
		const target = {
			id: 'rev1',
			kind: ChatKinds.CalendarTime,
			author: ALICE,
			d: 'event-1'
		};
		expect(createCalendarRsvpTags(target, 'accepted')).toContainEqual(['alt', 'RSVP: Going']);
		expect(createCalendarRsvpTags(target, 'tentative')).toContainEqual(['alt', 'RSVP: Maybe']);
		expect(createCalendarRsvpTags(target, 'declined')).toContainEqual(['alt', "RSVP: Can't go"]);
		expect(createCalendarCancelTags(target)).toContainEqual(['alt', 'Calendar event cancelled']);
	});

	it('carries a cover image through the round trip', () => {
		const built = createCalendarEventMessage({
			d: 'cover',
			draft: draft({ image: 'https://example.com/cover.jpg' }),
			timeZone: TZ
		});
		expect(built.tags).toContainEqual(['image', 'https://example.com/cover.jpg']);
		const parsed = getCalendarEventDefinition(built.kind, built.content, built.tags)!;
		expect(parsed.image).toBe('https://example.com/cover.jpg');
		expect(calendarDraftFromDefinition(parsed).image).toBe('https://example.com/cover.jpg');
	});

	it('builds an all-day event without clock tags', () => {
		const built = createCalendarEventMessage({
			d: 'fair',
			draft: draft({ allDay: true, startDate: '2026-11-20', endDate: '2026-11-22' }),
			timeZone: TZ
		});
		expect(built.kind).toBe(ChatKinds.CalendarDate);
		expect(built.tags).toContainEqual(['start', '2026-11-20']);
		expect(built.tags).toContainEqual(['end', '2026-11-22']);
		expect(built.tags.some((tag) => tag[0] === 'D')).toBe(false);

		const parsed = getCalendarEventDefinition(built.kind, built.content, built.tags);
		expect(parsed).toMatchObject({ allDay: true, startDate: '2026-11-20', endDate: '2026-11-22' });
		expect(parsed!.end - parsed!.start).toBe(2 * 86_400);
	});

	it('throws on invalid drafts and identifiers', () => {
		expect(() =>
			createCalendarEventMessage({ d: 'abc', draft: draft({ title: '' }), timeZone: TZ })
		).toThrow(/Title/);
		expect(() => createCalendarEventMessage({ d: 'bad id', draft: draft(), timeZone: TZ })).toThrow(
			/identifier/
		);
	});

	it('keeps every valid link', () => {
		const built = createCalendarEventMessage({ d: 'links', draft: draft(), timeZone: TZ });
		const links = Array.from({ length: 6 }, (_, index) => ['r', `https://example.com/${index}`]);
		const parsed = getCalendarEventDefinition(built.kind, built.content, [...built.tags, ...links]);
		expect(parsed?.links).toHaveLength(6);
	});

	it('rejects malformed and duplicate inbound tags', () => {
		const built = createCalendarEventMessage({ d: 'abc', draft: draft(), timeZone: TZ });
		expect(getCalendarEventDefinition(ChatKinds.Text, built.content, built.tags)).toBeNull();
		expect(
			getCalendarEventDefinition(built.kind, built.content, [...built.tags, ['start', '123']])
		).toBeNull(); // duplicate scalar
		expect(
			getCalendarEventDefinition(built.kind, built.content, [
				['d', 'abc'],
				['title', 'x'],
				['start', 'soon']
			])
		).toBeNull();
		expect(
			getCalendarEventDefinition(
				built.kind,
				built.content,
				built.tags.map((tag) => (tag[0] === 'r' ? ['r', 'javascript:1'] : tag))
			)
		).not.toBeNull(); // no r tags in the fixture
	});

	it('rejects timestamps outside the JavaScript date range', () => {
		const built = createCalendarEventMessage({ d: 'abc', draft: draft(), timeZone: TZ });
		expect(
			getCalendarEventDefinition(
				built.kind,
				built.content,
				built.tags.map((tag) => (tag[0] === 'start' ? ['start', '1e100'] : tag))
			)
		).toBeNull();
		expect(
			getCalendarEventDefinition(
				built.kind,
				built.content,
				built.tags.map((tag) => (tag[0] === 'end' ? ['end', '1e100'] : tag))
			)
		).toBeNull();
	});
});

describe('calendar day keys', () => {
	it('covers every authored date of an all-day event', () => {
		const definition = {
			allDay: true,
			startDate: '2026-11-20',
			endDate: '2026-11-22',
			start: Date.UTC(2026, 10, 20) / 1000,
			end: Date.UTC(2026, 10, 22) / 1000
		};
		expect(calendarEventDayKeys(definition, TZ)).toEqual(['2026-11-20', '2026-11-21']);
	});

	it('dots a timed event on the viewer’s local day, not UTC', () => {
		const built = createCalendarEventMessage({
			d: 'late',
			// 23:30 Madrid on the 20th is 22:30 UTC — same day either way; use 00:30 to cross.
			draft: draft({ startDate: '2026-11-20', startTime: '00:30', endTime: '01:00' }),
			timeZone: TZ
		});
		const definition = getCalendarEventDefinition(built.kind, built.content, built.tags)!;
		expect(calendarEventDayKeys(definition, 'Asia/Tokyo')).toEqual(['2026-11-20']);
		expect(calendarEventDayKeys(definition, 'America/Los_Angeles')).toEqual(['2026-11-19']);
	});
});

describe('calendar projection', () => {
	it('round-trips a multiline description', () => {
		const built = createCalendarEventMessage({
			d: 'notes',
			draft: draft({ description: 'Bring the roadmap.\n\nWe start on time.' }),
			timeZone: TZ
		});
		expect(getCalendarEventDefinition(built.kind, built.content, built.tags)?.description).toBe(
			'Bring the roadmap.\n\nWe start on time.'
		);
	});

	it('keeps the newest revision of an addressable event', () => {
		const older = eventMessage('rev1', { eventCreatedAt: 100, cursor: 1 });
		const newer = eventMessage('rev2', {
			eventCreatedAt: 200,
			cursor: 2,
			draft: { title: 'Planning call (moved)' }
		});
		const cards = buildCalendarProjection([newer, older], { myPubkey: ME, timeZone: TZ });
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			id: 'rev2',
			revisionIds: ['rev2', 'rev1'],
			revised: true,
			cancelled: false
		});
		expect(cards[0].definition.title).toBe('Planning call (moved)');
		expect(findCalendarEvent(cards, 'rev1')?.id).toBe('rev2');
	});

	it('orders revisions by created_at even when the cursor disagrees', () => {
		const newerButLaterCursor = eventMessage('rev1', { eventCreatedAt: 200, cursor: 9 });
		const olderButEarlierCursor = eventMessage('rev2', {
			eventCreatedAt: 100,
			cursor: 2,
			draft: { title: 'Stale copy' }
		});
		const cards = buildCalendarProjection([olderButEarlierCursor, newerButLaterCursor], {
			myPubkey: ME,
			timeZone: TZ
		});
		expect(cards[0].id).toBe('rev1');
	});

	it('cancels only on the author’s later deletion', () => {
		const event = eventMessage('rev1', { cursor: 1 });
		const cancel = message('del', {
			kind: ChatKinds.Deletion,
			cursor: 2,
			content: 'Cancelled',
			tags: createCalendarCancelTags({
				id: 'rev1',
				kind: ChatKinds.CalendarTime,
				author: ALICE,
				d: 'event-1'
			})
		});
		const stranger = { ...cancel, id: 'del2', sender: BOB, cursor: 3 };

		expect(
			buildCalendarProjection([event, cancel], { myPubkey: ME, timeZone: TZ })[0].cancelled
		).toBe(true);
		expect(
			buildCalendarProjection([event, stranger], { myPubkey: ME, timeZone: TZ })[0].cancelled
		).toBe(false);
	});

	it('revives an event re-created after its cancellation', () => {
		const event = eventMessage('rev1', { cursor: 1 });
		const cancel = message('del', {
			kind: ChatKinds.Deletion,
			cursor: 2,
			tags: createCalendarCancelTags({
				id: 'rev1',
				kind: ChatKinds.CalendarTime,
				author: ALICE,
				d: 'event-1'
			})
		});
		const revived = eventMessage('rev2', { cursor: 3, eventCreatedAt: 1_760_000_500 });
		expect(
			buildCalendarProjection([event, cancel, revived], { myPubkey: ME, timeZone: TZ })[0].cancelled
		).toBe(false);
	});

	it('keeps one RSVP per account, latest wins across devices', () => {
		const event = eventMessage('rev1', { cursor: 1 });
		const target = { id: 'rev1', kind: ChatKinds.CalendarTime, author: ALICE, d: 'event-1' };
		const rsvp = (
			id: string,
			sender: string,
			status: 'accepted' | 'tentative' | 'declined',
			cursor: number
		) =>
			message(id, {
				kind: ChatKinds.CalendarRsvp,
				sender,
				cursor,
				content: status,
				tags: createCalendarRsvpTags(target, status)
			});

		const cards = buildCalendarProjection(
			[
				event,
				rsvp('r1', BOB, 'accepted', 2),
				rsvp('r2', ME, 'declined', 3),
				rsvp('r3', ME, 'tentative', 4)
			],
			{ myPubkey: ME, timeZone: TZ }
		);
		expect(cards[0].going.map((attendee) => attendee.pubkey)).toEqual([BOB]);
		expect(cards[0].declined).toEqual([]);
		expect(cards[0].maybe.map((attendee) => attendee.pubkey)).toEqual([ME]);
		expect(cards[0].myStatus).toBe('tentative');
	});

	it('ignores RSVPs for other events and finds cards by revision id', () => {
		const event = eventMessage('rev1', { cursor: 1 });
		const otherRsvp = message('r1', {
			kind: ChatKinds.CalendarRsvp,
			cursor: 2,
			tags: createCalendarRsvpTags(
				{ id: 'elsewhere', kind: ChatKinds.CalendarTime, author: ALICE, d: 'event-2' },
				'accepted'
			)
		});
		const cards = buildCalendarProjection([event, otherRsvp], { myPubkey: ME, timeZone: TZ });
		expect(cards).toHaveLength(1);
		expect(cards[0].going).toEqual([]);
		expect(findCalendarEvent(cards, 'rev1')?.coordinate).toBe(
			`${ChatKinds.CalendarTime}:${ALICE}:event-1`
		);
		expect(findCalendarEvent(cards, 'nope')).toBeNull();
	});

	it('orders same-account RSVPs by created_at before cursor', () => {
		const event = eventMessage('rev1', { cursor: 1 });
		const target = { id: 'rev1', kind: ChatKinds.CalendarTime, author: ALICE, d: 'event-1' };
		const older = message('r1', {
			kind: ChatKinds.CalendarRsvp,
			sender: ME,
			cursor: 9,
			createdAt: 100_000,
			eventCreatedAt: 100,
			tags: createCalendarRsvpTags(target, 'accepted')
		});
		const newer = message('r2', {
			kind: ChatKinds.CalendarRsvp,
			sender: ME,
			cursor: 2,
			createdAt: 200_000,
			eventCreatedAt: 200,
			tags: createCalendarRsvpTags(target, 'declined')
		});
		const cards = buildCalendarProjection([event, older, newer], {
			myPubkey: ME,
			timeZone: TZ
		});
		expect(cards[0].myStatus).toBe('declined');
	});

	it('parses RSVP references and rejects malformed ones', () => {
		const tags = createCalendarRsvpTags(
			{ id: 'rev1', kind: ChatKinds.CalendarDate, author: ALICE, d: 'event-1' },
			'declined'
		);
		expect(getCalendarRsvpReference(ChatKinds.CalendarRsvp, tags)).toEqual({
			coordinate: `${ChatKinds.CalendarDate}:${ALICE}:event-1`,
			eventId: 'rev1',
			author: ALICE,
			status: 'declined'
		});
		expect(getCalendarRsvpReference(ChatKinds.CalendarRsvp, [])).toBeNull();
		expect(
			getCalendarRsvpReference(ChatKinds.CalendarRsvp, [
				['a', `9999:${ALICE}:x`],
				['status', 'accepted']
			])
		).toBeNull();
		expect(
			getCalendarRsvpReference(ChatKinds.CalendarRsvp, [
				['a', `${ChatKinds.CalendarTime}:${ALICE}:x`],
				['status', 'maybe']
			])
		).toBeNull();
	});
});
