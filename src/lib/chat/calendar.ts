/**
 * NIP-52 calendar events and RSVPs adapted to cordn: NIP tag shapes carried as
 * unsigned event envelopes sealed as ordinary MLS group messages. See
 * `src/lib/chat/README.md` — an RSVP is a kind-specific sparse aggregate (the
 * event's renderers self-query them), exactly like a poll response.
 *
 * The group IS the calendar: there is no kind-31924 calendar list, and
 * therefore no collaborative "request to be added" flow. Addressable identity
 * is `${kind}:${author}:${d}`; the newest revision wins (envelope `created_at`,
 * then coordinator cursor), and a NIP-09 deletion by the author cancels it.
 *
 * ponytail limits, revisit when a real need lands:
 * - Recurring events are unsupported (NIP-52 punts them to clients).
 * - The composer schedules in the device's time zone (`start_tzid`); viewers
 *   elsewhere get the converted time. Add a zone picker if cross-zone authoring
 *   is needed.
 * - A multi-day event is bounded to CALENDAR_MAX_DAYS day keys.
 * - `fb` (free/busy) is not sent: nothing in the UI consumes availability.
 */
import { ChatKinds } from '$lib/chat/kinds';
import { isSafeDisplayText, utf8ByteLength } from '$lib/chat/displayText';
import { safeNormalizePubKey } from '$lib/utils';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

export const CALENDAR_MAX_TITLE_BYTES = 256;
export const CALENDAR_MAX_DESCRIPTION_BYTES = 8192;
export const CALENDAR_MAX_LOCATION_BYTES = 512;
export const CALENDAR_MAX_LINK_BYTES = 1024;
export const CALENDAR_MAX_LINKS = 4;
export const CALENDAR_MAX_TAGS = 64;
/** Bound the day-key expansion of a multi-day event. */
export const CALENDAR_MAX_DAYS = 366;

export type CalendarRsvpStatus = 'accepted' | 'tentative' | 'declined';

export const CALENDAR_RSVP_LABELS: Record<CalendarRsvpStatus, string> = {
	accepted: 'Going',
	tentative: 'Maybe',
	declined: "Can't go"
};

export const CALENDAR_RSVP_STATUSES: CalendarRsvpStatus[] = ['accepted', 'tentative', 'declined'];

/** Kinds the calendar read model needs: event revisions, RSVPs, and the
 *  author's kind-5 cancellations. */
export const CALENDAR_MESSAGE_KINDS: readonly number[] = [
	ChatKinds.CalendarDate,
	ChatKinds.CalendarTime,
	ChatKinds.CalendarRsvp,
	ChatKinds.Deletion
];

export function isCalendarEventKind(kind: number): boolean {
	return kind === ChatKinds.CalendarDate || kind === ChatKinds.CalendarTime;
}

/** Kinds whose payload legitimately carries no body text: a calendar event's
 *  description may be empty (NIP-52). The send path's "content required" guard
 *  consults this. */
export function isCalendarSendKind(kind: number): boolean {
	return isCalendarEventKind(kind);
}

// ---------------------------------------------------------------------------
// Dates, times, time zones
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

function isIsoDate(value: string): boolean {
	const match = ISO_DATE.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1) return false;
	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoToUtcSeconds(value: string): number {
	const [year, month, day] = value.split('-').map(Number);
	return Date.UTC(year, month - 1, day) / 1000;
}

function utcSecondsToIso(seconds: number): string {
	return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function nextIsoDate(value: string): string {
	return utcSecondsToIso(isoToUtcSeconds(value) + 86_400);
}

/** The device's IANA zone: the composer's default and the viewer conversion
 *  for timed events. */
export function viewerTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

export function isValidTimeZone(value: string): boolean {
	if (!value) return false;
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of an instant in `timeZone` — assembled from parts so the
 *  result never depends on the locale's field order. */
function localDayKey(millis: number, timeZone: string): string {
	let formatter = dayKeyFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});
		dayKeyFormatters.set(timeZone, formatter);
	}
	const parts = formatter.formatToParts(new Date(millis));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The local wall-clock instant of a date + time, in the device's zone. */
function localWallClockSeconds(date: string, time: string): number {
	const [year, month, day] = date.split('-').map(Number);
	const [hours, minutes] = time.split(':').map(Number);
	return Math.floor(new Date(year, month - 1, day, hours, minutes, 0, 0).getTime() / 1000);
}

function isHttpUrl(value: string): boolean {
	if (utf8ByteLength(value) > CALENDAR_MAX_LINK_BYTES) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Send-side drafts
// ---------------------------------------------------------------------------

/** Send-side event intent. Dates and times are the author's local wall clock;
 *  the builder converts them to the NIP-52 tag shapes. */
export interface CalendarEventDraft {
	title: string;
	description: string;
	location: string;
	link: string;
	/** Cover image URL (https/http); `''` = none. */
	image: string;
	/** All-day events use the dates and ignore the times. */
	allDay: boolean;
	/** `YYYY-MM-DD`. */
	startDate: string;
	/** `YYYY-MM-DD`, exclusive; `''` = none. */
	endDate: string;
	/** `HH:MM` (24h), timed events only; `''` = none. */
	startTime: string;
	endTime: string;
}

interface ResolvedTiming {
	allDay: boolean;
	startSeconds: number;
	/** Exclusive. All-day: UTC midnight of the day after the last covered day. */
	endSeconds: number;
	startDate: string;
	endDate: string;
	startTime: string;
	endTime: string;
}

function trimmedDraft(draft: CalendarEventDraft): CalendarEventDraft {
	return {
		...draft,
		title: draft.title.trim(),
		description: draft.description.trim(),
		location: draft.location.trim(),
		link: draft.link.trim(),
		image: draft.image.trim()
	};
}

function timingFromDraft(draft: CalendarEventDraft): ResolvedTiming | null {
	if (!isIsoDate(draft.startDate)) return null;
	if (draft.allDay) {
		if (draft.endDate && !isIsoDate(draft.endDate)) return null;
		const startSeconds = isoToUtcSeconds(draft.startDate);
		const endSeconds = draft.endDate ? isoToUtcSeconds(draft.endDate) : startSeconds + 86_400;
		return {
			allDay: true,
			startSeconds,
			endSeconds,
			startDate: draft.startDate,
			endDate: draft.endDate,
			startTime: '',
			endTime: ''
		};
	}
	if (!CLOCK_TIME.test(draft.startTime)) return null;
	if (draft.endTime && !CLOCK_TIME.test(draft.endTime)) return null;
	const startSeconds = localWallClockSeconds(draft.startDate, draft.startTime);
	const endSeconds = draft.endTime
		? localWallClockSeconds(draft.startDate, draft.endTime)
		: startSeconds;
	if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
	return {
		allDay: false,
		startSeconds,
		endSeconds,
		startDate: draft.startDate,
		endDate: '',
		startTime: draft.startTime,
		endTime: draft.endTime
	};
}

/** Returns a human-readable error for an invalid draft, or null when sendable. */
export function validateCalendarEventDraft(
	draft: CalendarEventDraft,
	timeZone: string
): string | null {
	const normalized = trimmedDraft(draft);
	// Newlines are ordinary description whitespace, not spoofing controls.
	// Replacing them one-for-one preserves the byte-limit check.
	const safeDescription = normalized.description.replace(/[\r\n]/g, ' ');
	if (!isSafeDisplayText(normalized.title, CALENDAR_MAX_TITLE_BYTES)) {
		return 'Title is required (max 256 bytes, no control characters)';
	}
	if (
		normalized.description &&
		!isSafeDisplayText(safeDescription, CALENDAR_MAX_DESCRIPTION_BYTES)
	) {
		return 'Description is too long (max 8192 bytes, no control characters)';
	}
	if (normalized.location && !isSafeDisplayText(normalized.location, CALENDAR_MAX_LOCATION_BYTES)) {
		return 'Location is too long (max 512 bytes, no control characters)';
	}
	if (normalized.link && !isHttpUrl(normalized.link)) {
		return 'Link must be a valid http(s) URL';
	}
	if (normalized.image && !isHttpUrl(normalized.image)) {
		return 'Cover image must be a valid http(s) URL';
	}
	if (!isValidTimeZone(timeZone)) return 'Unknown time zone';
	const timing = timingFromDraft(normalized);
	if (!timing) return 'Pick a valid date and time';
	if (timing.allDay) {
		if (timing.endSeconds <= timing.startSeconds)
			return 'The end date must be after the start date';
	} else if (normalized.endTime && timing.endSeconds <= timing.startSeconds) {
		return 'The end time must be after the start time';
	}
	return null;
}

/** Day-granularity indexes (`D` tags) covering a timed event's timeframe. */
function utcDayIndexes(startSeconds: number, endSeconds: number): number[] {
	const last = endSeconds > startSeconds ? endSeconds - 1 : startSeconds;
	const first = Math.floor(startSeconds / 86_400);
	const final = Math.floor(last / 86_400);
	const days: number[] = [];
	for (let day = first; day <= final && days.length < CALENDAR_MAX_DAYS; day += 1) days.push(day);
	return days;
}

export interface CalendarEventMessage {
	kind: number;
	content: string;
	tags: string[][];
}

/** Builds a kind-31922/31923 payload from a validated draft. Throws on invalid
 *  drafts so a buggy caller can never mint an event other clients refuse. */
export function createCalendarEventMessage(input: {
	/** Stable addressable identifier — reuse it for every revision. */
	d: string;
	draft: CalendarEventDraft;
	timeZone: string;
}): CalendarEventMessage {
	if (!IDENTIFIER.test(input.d)) throw new Error('Invalid calendar event identifier');
	const draft = trimmedDraft(input.draft);
	const error = validateCalendarEventDraft(draft, input.timeZone);
	if (error) throw new Error(error);
	const timing = timingFromDraft(draft);
	if (!timing) throw new Error('Pick a valid date and time');

	const kind = timing.allDay ? ChatKinds.CalendarDate : ChatKinds.CalendarTime;
	const tags: string[][] = [
		['d', input.d],
		['title', draft.title]
	];
	if (timing.allDay) {
		tags.push(['start', timing.startDate]);
		if (timing.endDate) tags.push(['end', timing.endDate]);
	} else {
		tags.push(['start', String(timing.startSeconds)]);
		if (draft.endTime) tags.push(['end', String(timing.endSeconds)]);
		for (const day of utcDayIndexes(timing.startSeconds, timing.endSeconds)) {
			tags.push(['D', String(day)]);
		}
		tags.push(['start_tzid', input.timeZone]);
		if (draft.endTime) tags.push(['end_tzid', input.timeZone]);
	}
	if (draft.location) tags.push(['location', draft.location]);
	if (draft.image) tags.push(['image', draft.image]);
	if (draft.link) tags.push(['r', draft.link]);
	// NIP-31 plaintext summary for clients that cannot render calendar events.
	tags.push(['alt', `Calendar event: ${draft.title}`]);

	return { kind, content: draft.description, tags };
}

// ---------------------------------------------------------------------------
// Addressable identity
// ---------------------------------------------------------------------------

export interface CalendarEventTarget {
	/** Latest revision's event id. */
	id: string;
	kind: number;
	author: string;
	d: string;
}

export function calendarCoordinate(event: { kind: number; author: string; d: string }): string {
	return `${event.kind}:${event.author}:${event.d}`;
}

/** The addressable target of a card's latest revision. */
export function calendarEventTarget(card: {
	id: string;
	kind: number;
	author: string;
	d: string;
}): CalendarEventTarget {
	return { id: card.id, kind: card.kind, author: card.author, d: card.d };
}

export function parseCalendarCoordinate(
	value: string
): { kind: number; author: string; d: string } | null {
	const [kind, author, d, ...rest] = value.split(':');
	if (rest.length > 0) return null;
	const parsedKind = Number(kind);
	if (!isCalendarEventKind(parsedKind)) return null;
	const normalized = safeNormalizePubKey(author ?? '');
	if (!normalized) return null;
	if (!d || !IDENTIFIER.test(d)) return null;
	return { kind: parsedKind, author: normalized, d };
}

/** Builds kind-31925 tags. `d` is derived from the event's identifier so every
 *  device of the same account converges on one logical RSVP. */
export function createCalendarRsvpTags(
	event: CalendarEventTarget,
	status: CalendarRsvpStatus
): string[][] {
	return [
		['a', calendarCoordinate(event)],
		['e', event.id, '', event.author],
		['d', `rsvp-${event.d}`],
		['status', status],
		['p', event.author],
		// NIP-31 plaintext summary for clients that cannot render RSVPs.
		['alt', `RSVP: ${CALENDAR_RSVP_LABELS[status]}`]
	];
}

/** Builds kind-5 tags cancelling an event: the `a` coordinate (all revisions up
 *  to this point) plus the latest revision's `e`, so the chat row hides through
 *  the ordinary deletion fold as well. */
export function createCalendarCancelTags(event: CalendarEventTarget): string[][] {
	return [
		['a', calendarCoordinate(event)],
		['e', event.id, '', event.author],
		['k', String(event.kind)],
		['alt', 'Calendar event cancelled']
	];
}

// ---------------------------------------------------------------------------
// Inbound parsers (strict on known shapes, tolerant of unknown extension tags)
// ---------------------------------------------------------------------------

function findTag(tags: string[][], name: string): string[] | undefined {
	return tags.find((tag) => tag[0] === name);
}

export interface CalendarEventDefinition {
	d: string;
	kind: number;
	allDay: boolean;
	title: string;
	description: string;
	summary: string;
	location: string;
	image: string;
	links: string[];
	/** Unix seconds. All-day: UTC midnight of `startDate`. */
	start: number;
	/** Unix seconds, exclusive. All-day: UTC midnight of `endDate` (or +1 day). */
	end: number;
	startDate: string;
	/** `''` when the event has no explicit end date. */
	endDate: string;
	startTzid: string;
	endTzid: string;
}

const SCALAR_TAGS = new Set([
	'd',
	'title',
	'start',
	'end',
	'start_tzid',
	'end_tzid',
	'location',
	'image',
	'summary'
]);

export function getCalendarEventDefinition(
	kind: number,
	content: string,
	tags: string[][]
): CalendarEventDefinition | null {
	if (!isCalendarEventKind(kind) || tags.length > CALENDAR_MAX_TAGS) return null;

	const scalars = new Map<string, string>();
	const links: string[] = [];
	for (const tag of tags) {
		const name = tag[0];
		if (name === 'r') {
			if (tag.length !== 2 || !isHttpUrl(tag[1])) return null;
			if (!links.includes(tag[1]) && links.length < CALENDAR_MAX_LINKS) links.push(tag[1]);
			continue;
		}
		if (!SCALAR_TAGS.has(name)) continue; // unknown extension tags are ignored
		if (tag.length !== 2 || scalars.has(name)) return null;
		scalars.set(name, tag[1]);
	}

	const d = scalars.get('d') ?? '';
	if (!IDENTIFIER.test(d)) return null;
	const title = scalars.get('title') ?? '';
	if (!isSafeDisplayText(title, CALENDAR_MAX_TITLE_BYTES)) return null;

	const description = content.trim();
	if (
		description &&
		!isSafeDisplayText(description.replace(/[\r\n]/g, ' '), CALENDAR_MAX_DESCRIPTION_BYTES)
	)
		return null;
	const summary = scalars.get('summary') ?? '';
	if (summary && !isSafeDisplayText(summary, CALENDAR_MAX_TITLE_BYTES)) return null;
	const location = scalars.get('location') ?? '';
	if (location && !isSafeDisplayText(location, CALENDAR_MAX_LOCATION_BYTES)) return null;
	const image = scalars.get('image') ?? '';
	if (image && !isHttpUrl(image)) return null;

	const startTzid = scalars.get('start_tzid') ?? '';
	if (startTzid && !isValidTimeZone(startTzid)) return null;
	const endTzid = scalars.get('end_tzid') ?? startTzid;
	if (endTzid && !isValidTimeZone(endTzid)) return null;

	const startTag = scalars.get('start') ?? '';
	const endTag = scalars.get('end') ?? '';

	if (kind === ChatKinds.CalendarDate) {
		if (!isIsoDate(startTag)) return null;
		if (endTag && !isIsoDate(endTag)) return null;
		const start = isoToUtcSeconds(startTag);
		const end = endTag ? isoToUtcSeconds(endTag) : start + 86_400;
		if (end <= start) return null;
		return {
			d,
			kind,
			allDay: true,
			title,
			description,
			summary,
			location,
			image,
			links,
			start,
			end,
			startDate: startTag,
			endDate: endTag,
			startTzid,
			endTzid
		};
	}

	const start = Number(startTag);
	if (!Number.isInteger(start) || start <= 0) return null;
	const end = endTag ? Number(endTag) : start;
	if (!Number.isInteger(end) || end < start || (Boolean(endTag) && end === start)) return null;
	return {
		d,
		kind,
		allDay: false,
		title,
		description,
		summary,
		location,
		image,
		links,
		start,
		end,
		startDate: utcSecondsToIso(start),
		endDate: '',
		startTzid,
		endTzid
	};
}

/** The composer's draft for an existing event (edit prefill). Timed events are
 *  converted to the viewer's local wall clock, matching how the composer
 *  schedules. */
export function calendarDraftFromDefinition(
	definition: CalendarEventDefinition
): CalendarEventDraft {
	const base = {
		title: definition.title,
		description: definition.description,
		location: definition.location,
		link: definition.links[0] ?? '',
		image: definition.image
	};
	if (definition.allDay) {
		return {
			...base,
			allDay: true,
			startDate: definition.startDate,
			endDate: definition.endDate,
			startTime: '',
			endTime: ''
		};
	}
	const pad = (value: number) => String(value).padStart(2, '0');
	const start = new Date(definition.start * 1000);
	const end = new Date(definition.end * 1000);
	return {
		...base,
		allDay: false,
		startDate: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
		endDate: '',
		startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
		endTime:
			definition.end > definition.start ? `${pad(end.getHours())}:${pad(end.getMinutes())}` : ''
	};
}

export interface CalendarRsvpReference {
	coordinate: string;
	eventId: string;
	author: string;
	status: CalendarRsvpStatus;
}

export function getCalendarRsvpReference(
	kind: number,
	tags: string[][]
): CalendarRsvpReference | null {
	if (kind !== ChatKinds.CalendarRsvp || tags.length > CALENDAR_MAX_TAGS) return null;

	const coordinateTag = findTag(tags, 'a');
	const coordinate = coordinateTag?.[1] ? parseCalendarCoordinate(coordinateTag[1]) : null;
	if (!coordinate) return null;

	const statusTag = findTag(tags, 'status');
	const status = statusTag?.[1];
	if (!status || !CALENDAR_RSVP_STATUSES.includes(status as CalendarRsvpStatus)) return null;

	const eventTag = findTag(tags, 'e');
	return {
		coordinate: calendarCoordinate(coordinate),
		eventId: eventTag?.[1] ?? '',
		author: coordinate.author,
		status: status as CalendarRsvpStatus
	};
}

/** A kind-5 cancellation of a calendar event, or null for any other deletion. */
export function getCalendarCancellation(
	kind: number,
	tags: string[][]
): { coordinate: string; author: string } | null {
	if (kind !== ChatKinds.Deletion) return null;
	const coordinateTag = findTag(tags, 'a');
	if (!coordinateTag?.[1]) return null;
	const coordinate = parseCalendarCoordinate(coordinateTag[1]);
	if (!coordinate) return null;
	return { coordinate: calendarCoordinate(coordinate), author: coordinate.author };
}

// ---------------------------------------------------------------------------
// Projection — the calendar's read model
// ---------------------------------------------------------------------------

export interface CalendarAttendee {
	pubkey: string;
	cursor: number;
}

export interface CalendarEventCard {
	coordinate: string;
	d: string;
	kind: number;
	author: string;
	/** Latest revision's event id. */
	id: string;
	/** Every known revision id, so old chat/deep links resolve to this card. */
	revisionIds: string[];
	cursor: number;
	/** More than one revision arrived (replaced, not edited in place). */
	revised: boolean;
	cancelled: boolean;
	definition: CalendarEventDefinition;
	/** Day keys (`YYYY-MM-DD`) the event covers, in the viewer's zone. */
	dayKeys: string[];
	going: CalendarAttendee[];
	maybe: CalendarAttendee[];
	declined: CalendarAttendee[];
	myStatus: CalendarRsvpStatus | null;
}

/** Day keys an event covers. All-day events use their authored dates (no zone
 *  conversion — that is the point of a date-based event); timed events use the
 *  viewer's zone, so a 23:00 event dots the day the viewer sees it on. */
export function calendarEventDayKeys(
	definition: Pick<CalendarEventDefinition, 'allDay' | 'startDate' | 'endDate' | 'start' | 'end'>,
	timeZone: string
): string[] {
	const keys: string[] = [];
	if (definition.allDay) {
		let day = definition.startDate;
		const last = definition.endDate || nextIsoDate(definition.startDate);
		while (day < last && keys.length < CALENDAR_MAX_DAYS) {
			keys.push(day);
			day = nextIsoDate(day);
		}
		return keys;
	}
	const lastMillis =
		(definition.end > definition.start ? definition.end - 1 : definition.start) * 1000;
	let day = localDayKey(definition.start * 1000, timeZone);
	const last = localDayKey(lastMillis, timeZone);
	while (day <= last && keys.length < CALENDAR_MAX_DAYS) {
		keys.push(day);
		day = nextIsoDate(day);
	}
	return keys;
}

/** Revision order: the envelope's own `created_at` first (NIP-52 replaceable
 *  semantics), the coordinator cursor as the deterministic tie-break. */
function revisionRank(message: StoredChatMessage): [number, number] {
	return [message.eventCreatedAt ?? Math.floor(message.createdAt / 1000), message.cursor];
}

function isNewerRevision(next: StoredChatMessage, current: StoredChatMessage): boolean {
	const [nextAt, nextCursor] = revisionRank(next);
	const [currentAt, currentCursor] = revisionRank(current);
	return nextAt > currentAt || (nextAt === currentAt && nextCursor > currentCursor);
}

/**
 * Projects a group's calendar rows into event cards: latest revision per
 * coordinate, author-validated cancellations, and one effective RSVP per
 * account. Rows may come from durable storage, the live window, or both —
 * duplicates by cursor are harmless.
 */
export function buildCalendarProjection(
	messages: StoredChatMessage[],
	options: { myPubkey: string; timeZone: string }
): CalendarEventCard[] {
	const me = options.myPubkey ? safeNormalizePubKey(options.myPubkey) : '';
	const revisions = new Map<
		string,
		{ message: StoredChatMessage; definition: CalendarEventDefinition; revisionIds: string[] }
	>();
	const cancellations = new Map<string, StoredChatMessage>();
	const rsvps = new Map<
		string,
		Map<string, { message: StoredChatMessage; status: CalendarRsvpStatus }>
	>();

	for (const message of messages) {
		if (message.kind === ChatKinds.Deletion) {
			const cancellation = getCalendarCancellation(message.kind, message.tags);
			if (!cancellation) continue;
			const current = cancellations.get(cancellation.coordinate);
			if (!current || message.cursor > current.cursor) {
				cancellations.set(cancellation.coordinate, message);
			}
			continue;
		}

		if (message.kind === ChatKinds.CalendarRsvp) {
			const reference = getCalendarRsvpReference(message.kind, message.tags);
			if (!reference) continue;
			const sender = safeNormalizePubKey(message.sender);
			if (!sender) continue;
			const byAuthor = rsvps.get(reference.coordinate) ?? new Map();
			const current = byAuthor.get(sender);
			if (!current || isNewerRevision(message, current.message)) {
				byAuthor.set(sender, { message, status: reference.status });
			}
			rsvps.set(reference.coordinate, byAuthor);
			continue;
		}

		const definition = getCalendarEventDefinition(message.kind, message.content, message.tags);
		if (!definition) continue;
		const author = safeNormalizePubKey(message.sender);
		if (!author) continue;
		const coordinate = calendarCoordinate({ kind: definition.kind, author, d: definition.d });
		const current = revisions.get(coordinate);
		if (!current) {
			revisions.set(coordinate, { message, definition, revisionIds: [message.id] });
		} else if (isNewerRevision(message, current.message)) {
			revisions.set(coordinate, {
				message,
				definition,
				revisionIds: [...current.revisionIds, message.id]
			});
		} else {
			revisions.set(coordinate, {
				...current,
				revisionIds: [...current.revisionIds, message.id]
			});
		}
	}

	const cards: CalendarEventCard[] = [];
	for (const [coordinate, entry] of revisions) {
		const author = safeNormalizePubKey(entry.message.sender) ?? '';
		const cancellation = cancellations.get(coordinate);
		const cancelled = Boolean(
			cancellation &&
			safeNormalizePubKey(cancellation.sender) === author &&
			cancellation.cursor > entry.message.cursor
		);

		const going: CalendarAttendee[] = [];
		const maybe: CalendarAttendee[] = [];
		const declined: CalendarAttendee[] = [];
		let myStatus: CalendarRsvpStatus | null = null;
		for (const [pubkey, rsvp] of rsvps.get(coordinate) ?? []) {
			const attendee: CalendarAttendee = { pubkey, cursor: rsvp.message.cursor };
			if (rsvp.status === 'accepted') going.push(attendee);
			else if (rsvp.status === 'tentative') maybe.push(attendee);
			else declined.push(attendee);
			if (me && pubkey === me) myStatus = rsvp.status;
		}
		const byCursor = (a: CalendarAttendee, b: CalendarAttendee) => a.cursor - b.cursor;
		going.sort(byCursor);
		maybe.sort(byCursor);
		declined.sort(byCursor);

		cards.push({
			coordinate,
			d: entry.definition.d,
			kind: entry.definition.kind,
			author,
			id: entry.message.id,
			revisionIds: entry.revisionIds,
			cursor: entry.message.cursor,
			revised: entry.revisionIds.length > 1,
			cancelled,
			definition: entry.definition,
			dayKeys: calendarEventDayKeys(entry.definition, options.timeZone),
			going,
			maybe,
			declined,
			myStatus
		});
	}

	return cards.sort(
		(a, b) =>
			a.definition.start - b.definition.start ||
			a.definition.title.localeCompare(b.definition.title) ||
			a.coordinate.localeCompare(b.coordinate)
	);
}

/** The card an event id belongs to (any revision), or null. */
export function findCalendarEvent(
	cards: CalendarEventCard[],
	eventId: string
): CalendarEventCard | null {
	return cards.find((card) => card.revisionIds.includes(eventId)) ?? null;
}

/** The card for an addressable coordinate, or null. */
export function findCalendarEventByCoordinate(
	cards: CalendarEventCard[],
	coordinate: string
): CalendarEventCard | null {
	return cards.find((card) => card.coordinate === coordinate) ?? null;
}

/** Cards covering a day key, cancelled ones excluded. */
export function calendarEventsOnDay(
	cards: CalendarEventCard[],
	dayKey: string
): CalendarEventCard[] {
	return cards.filter((card) => !card.cancelled && card.dayKeys.includes(dayKey));
}
