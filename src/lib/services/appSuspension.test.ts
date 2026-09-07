import { describe, expect, test } from 'vitest';
import { suspensionDriftMs } from '$lib/services/appSuspension';

describe('suspensionDriftMs', () => {
	test('live-but-throttled hidden tab drifts ~0', () => {
		const stamps = { wall: 1_000, mono: 500 };
		// 60s later, both clocks advanced together
		expect(
			suspensionDriftMs(
				stamps,
				() => 61_000,
				() => 60_500
			)
		).toBe(0);
	});

	test('frozen process (monotonic clock paused) drifts by the suspension duration', () => {
		const stamps = { wall: 1_000, mono: 500 };
		expect(
			suspensionDriftMs(
				stamps,
				() => 121_000,
				() => 500
			)
		).toBe(120_000);
	});

	test('partial suspension accumulates only the frozen span', () => {
		const stamps = { wall: 1_000, mono: 500 };
		// 100s wall elapsed, only 40s monotonic elapsed → 60s suspended
		expect(
			suspensionDriftMs(
				stamps,
				() => 101_000,
				() => 40_500
			)
		).toBe(60_000);
	});
});
