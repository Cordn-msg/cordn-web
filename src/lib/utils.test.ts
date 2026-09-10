import { describe, expect, it } from 'vitest';
import { formatUnixTimestamp, normalizePubKey, safeNormalizePubKey, samePubKey } from './utils';

describe('timestamp formatting', () => {
	it('matches direct toLocaleString and stays stable across cached repeats', () => {
		const ts = 1700000000000;
		for (const [showTime, showDate] of [
			[true, false],
			[false, true],
			[true, true]
		] as const) {
			const options: Intl.DateTimeFormatOptions = {};
			if (showDate) options.dateStyle = 'medium';
			if (showTime) options.timeStyle = 'short';
			const expected = new Date(ts).toLocaleString(undefined, options);
			expect(formatUnixTimestamp(ts, showTime, showDate)).toBe(expected);
			// Second call exercises the memoized-string path.
			expect(formatUnixTimestamp(ts, showTime, showDate)).toBe(expected);
		}
		expect(formatUnixTimestamp(ts, true, false)).not.toBe(formatUnixTimestamp(ts, false, true));
	});
});

describe('pubkey normalization', () => {
	it('normalizePubKey lowercases valid hex and throws on invalid input', () => {
		expect(normalizePubKey('AA'.repeat(32))).toBe('aa'.repeat(32));
		expect(() => normalizePubKey('not-hex')).toThrow();
	});

	it('safeNormalizePubKey returns empty string instead of throwing', () => {
		expect(safeNormalizePubKey('AA'.repeat(32))).toBe('aa'.repeat(32));
		expect(safeNormalizePubKey('not-hex')).toBe('');
		expect(safeNormalizePubKey('')).toBe('');
	});

	it('samePubKey compares case-insensitively without validating', () => {
		expect(samePubKey('AA'.repeat(32), 'aa'.repeat(32))).toBe(true);
		expect(samePubKey('zz', 'zz')).toBe(true);
		expect(samePubKey('aa'.repeat(32), 'bb'.repeat(32))).toBe(false);
	});
});
