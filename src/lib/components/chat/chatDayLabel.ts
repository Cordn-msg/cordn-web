import { formatUnixTimestamp } from '$lib/utils';

/**
 * Local calendar-day ordinal key (YYYYMMDD). Derived from local Y/M/D instead
 * of epoch arithmetic so DST shifts can't merge or split adjacent days.
 */
export function chatDayKey(timestamp: number): number {
	const date = new Date(timestamp);
	return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * Day separator label for chat rows: "Today"/"Yesterday" for the two most
 * recent local days, otherwise the existing medium date label. Computed at
 * render time (not stored on the message) so an open chat crossing midnight
 * doesn't keep showing a stale "Today".
 */
export function formatChatDayLabel(timestamp: number, now: number = Date.now()): string {
	const key = chatDayKey(timestamp);
	if (key === chatDayKey(now)) return 'Today';

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (key === chatDayKey(yesterday.getTime())) return 'Yesterday';

	return formatUnixTimestamp(timestamp, false, true);
}
