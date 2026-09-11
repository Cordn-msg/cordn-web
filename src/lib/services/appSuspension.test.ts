import { describe, expect, test } from 'vitest';
import { shouldRebuildAfterBackground } from './appSuspension';

describe('background recovery', () => {
	test('does not rebuild for focus alone or a brief tab switch', () => {
		expect(shouldRebuildAfterBackground(null, 60_000)).toBe(false);
		expect(shouldRebuildAfterBackground(1_000, 2_000)).toBe(false);
	});

	test('rebuilds after a long hide regardless of monotonic clock behavior', () => {
		expect(shouldRebuildAfterBackground(1_000, 11_000)).toBe(true);
		expect(shouldRebuildAfterBackground(1_000, 120_000)).toBe(true);
	});
});
