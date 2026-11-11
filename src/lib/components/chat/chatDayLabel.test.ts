import { describe, expect, it } from 'vitest';
import { chatDayKey, formatChatDayLabel } from './chatDayLabel';
import { formatUnixTimestamp } from '$lib/utils';

describe('chat day labels', () => {
	it('uses the absolute medium date, including for the current day', () => {
		const timestamp = new Date(2025, 10, 10, 12, 0, 0).getTime();
		expect(formatChatDayLabel(timestamp)).toBe(formatUnixTimestamp(timestamp, false, true));
	});

	it('keeps adjacent local days distinct across month boundaries', () => {
		const oct31 = new Date(2025, 9, 31, 12, 0, 0).getTime();
		const nov1 = new Date(2025, 10, 1, 12, 0, 0).getTime();
		expect(chatDayKey(oct31)).not.toBe(chatDayKey(nov1));
	});
});
