/**
 * Calendar event formatting for every surface (chat card, details, agenda).
 * One place, so the same event never reads differently in two views.
 *
 * All-day events are date-based by definition: their authored dates are shown
 * as-is, never converted. Timed events are shown in the viewer's zone, with the
 * author's zone named only when it differs.
 */
import type { CalendarEventCard, CalendarEventDefinition } from '$lib/chat/calendar';
import { viewerTimeZone } from '$lib/chat/calendar';

const dayFormatter = new Intl.DateTimeFormat(undefined, {
	weekday: 'short',
	month: 'short',
	day: 'numeric'
});
const dayLongFormatter = new Intl.DateTimeFormat(undefined, {
	weekday: 'long',
	month: 'long',
	day: 'numeric'
});
const monthDayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** `YYYY-MM-DD` → a local Date at noon (no zone shift can move the day). */
function dayKeyToDate(dayKey: string): Date {
	const [year, month, day] = dayKey.split('-').map(Number);
	return new Date(year, month - 1, day, 12);
}

export function formatCalendarDay(dayKey: string): string {
	return dayFormatter.format(dayKeyToDate(dayKey));
}

export function formatCalendarDayLong(dayKey: string): string {
	return dayLongFormatter.format(dayKeyToDate(dayKey));
}

export function formatCalendarMonthDay(dayKey: string): string {
	return monthDayFormatter.format(dayKeyToDate(dayKey));
}

function formatTime(seconds: number): string {
	return timeFormatter.format(new Date(seconds * 1000));
}

/** The event's time span: `18:00 – 19:30`, `18:00`, or `All day`. */
export function formatCalendarTime(
	definition: Pick<CalendarEventDefinition, 'allDay' | 'start' | 'end'>
): string {
	if (definition.allDay) return 'All day';
	if (definition.end <= definition.start) return formatTime(definition.start);
	return `${formatTime(definition.start)} – ${formatTime(definition.end)}`;
}

function lastAllDayKey(definition: Pick<CalendarEventDefinition, 'endDate' | 'end'>): string {
	if (!definition.endDate) return definition.endDate;
	return new Date((definition.end - 86_400) * 1000).toISOString().slice(0, 10);
}

/** One-line "when" for cards: `Fri, Nov 20 · 18:00 – 19:30`. */
export function formatCalendarWhen(
	definition: Pick<CalendarEventDefinition, 'allDay' | 'start' | 'end' | 'startDate' | 'endDate'>
): string {
	if (definition.allDay) {
		const last = definition.endDate ? lastAllDayKey(definition) : definition.startDate;
		const span =
			last === definition.startDate
				? formatCalendarDay(definition.startDate)
				: `${formatCalendarMonthDay(definition.startDate)} – ${formatCalendarMonthDay(last)}`;
		return `${span} · All day`;
	}
	const startDay = new Date(definition.start * 1000);
	const endDay = new Date(
		(definition.end > definition.start ? definition.end : definition.start) * 1000
	);
	const sameDay = startDay.toDateString() === endDay.toDateString();
	const day = dayFormatter.format(startDay);
	return sameDay
		? `${day} · ${formatCalendarTime(definition)}`
		: `${day} ${formatTime(definition.start)} – ${dayFormatter.format(endDay)} ${formatTime(definition.end)}`;
}

/** Two-line "when" for the details view. */
export function formatCalendarWhenLong(
	definition: Pick<
		CalendarEventDefinition,
		'allDay' | 'start' | 'end' | 'startDate' | 'endDate' | 'startTzid'
	>
): string {
	if (definition.allDay) {
		const last = definition.endDate ? lastAllDayKey(definition) : definition.startDate;
		const span =
			last === definition.startDate
				? formatCalendarDayLong(definition.startDate)
				: `${formatCalendarDayLong(definition.startDate)} – ${formatCalendarDayLong(last)}`;
		return `${span} · All day`;
	}
	const zone = formatCalendarZone(definition);
	const day = dayLongFormatter.format(new Date(definition.start * 1000));
	return `${day} · ${formatCalendarTime(definition)}${zone ? ` (${zone})` : ''}`;
}

/** The author's zone, when it is not the viewer's (timed events only). */
export function formatCalendarZone(
	definition: Pick<CalendarEventDefinition, 'allDay' | 'startTzid'>
): string {
	if (definition.allDay || !definition.startTzid) return '';
	return definition.startTzid === viewerTimeZone() ? '' : definition.startTzid;
}

/** RSVP summary: `3 going · 1 maybe`. */
export function formatCalendarAttendance(card: CalendarEventCard): string {
	const parts: string[] = [];
	if (card.going.length > 0) parts.push(`${card.going.length} going`);
	if (card.maybe.length > 0) parts.push(`${card.maybe.length} maybe`);
	if (parts.length === 0) {
		return card.declined.length > 0 ? `${card.declined.length} can't go` : 'No responses yet';
	}
	return parts.join(' · ');
}
