import { formatUnixTimestamp } from '$lib/utils';

/**
 * Local calendar-day ordinal key (YYYYMMDD). Derived from local Y/M/D instead
 * of epoch arithmetic so DST shifts can't merge or split adjacent days.
 */
export function chatDayKey(timestamp: number): number {
	const date = new Date(timestamp);
	return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** Absolute medium date shared by inline separators and the floating chip. */
export function formatChatDayLabel(timestamp: number): string {
	return formatUnixTimestamp(timestamp, false, true);
}
