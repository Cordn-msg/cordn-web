import { describe, expect, it } from 'vitest';
import { chatDayKey, formatChatDayLabel } from './chatDayLabel';
import { formatUnixTimestamp } from '$lib/utils';

const now = new Date(2025, 10, 10, 12, 0, 0).getTime();

describe('chat day labels', () => {
	it('labels the current local day as Today', () => {
		expect(formatChatDayLabel(new Date(2025, 10, 10, 0, 1).getTime(), now)).toBe('Today');
		expect(formatChatDayLabel(new Date(2025, 10, 10, 23, 59).getTime(), now)).toBe('Today');
	});

	it('labels the previous local day as Yesterday', () => {
		expect(formatChatDayLabel(new Date(2025, 10, 9, 23, 59).getTime(), now)).toBe('Yesterday');
	});

	it('falls back to the medium date for older days', () => {
		const timestamp = new Date(2025, 10, 1, 12, 0, 0).getTime();
		expect(formatChatDayLabel(timestamp, now)).toBe(formatUnixTimestamp(timestamp, false, true));
	});

	it('keeps adjacent local days distinct across month boundaries', () => {
		const oct31 = new Date(2025, 9, 31, 12, 0, 0).getTime();
		const nov1 = new Date(2025, 10, 1, 12, 0, 0).getTime();
		expect(chatDayKey(oct31)).not.toBe(chatDayKey(nov1));
	});
});
