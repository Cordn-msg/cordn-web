import { describe, expect, it } from 'vitest';
import { PTR_THRESHOLD, dampPull, pullRotation } from './pullToRefresh';

describe('pullToRefresh gesture math', () => {
	it('damps and clamps the pull distance', () => {
		expect(dampPull(-100)).toBe(0);
		expect(dampPull(0)).toBe(0);
		expect(dampPull(100)).toBe(50);
		expect(dampPull(10_000)).toBe(96);
	});

	it('arms exactly at the release threshold', () => {
		expect(dampPull(PTR_THRESHOLD * 2)).toBe(PTR_THRESHOLD);
		expect(dampPull(PTR_THRESHOLD * 2 - 2)).toBeLessThan(PTR_THRESHOLD);
	});

	it('rotates the spinner proportionally, capped at a full turn', () => {
		expect(pullRotation(0)).toBe(0);
		expect(pullRotation(96)).toBe(360);
		expect(pullRotation(1000)).toBe(360);
	});
});
