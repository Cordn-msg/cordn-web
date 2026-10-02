import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false }));

import {
	coordinatorHealthStore,
	markCoordinatorDegraded,
	throwIfCoordinatorInReadBackoff
} from './coordinatorHealth.svelte';

const COORDINATOR = 'bb'.repeat(32);

beforeEach(() => {
	coordinatorHealthStore.byCoordinator.clear();
	vi.stubGlobal('document', { visibilityState: 'visible' });
	vi.useFakeTimers();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('coordinator read backoff', () => {
	test('hidden-tab failures do not arm the breaker', () => {
		// Hidden-tab socket death is timer throttling / dead radio, not
		// coordinator evidence (same rule as the watch-driver retry ladder):
		// marking would surface "Coordinator unreachable" on the user's return.
		vi.stubGlobal('document', { visibilityState: 'hidden' });
		markCoordinatorDegraded(COORDINATOR, 'Coordinator request timed out after 20000ms');
		expect(() => throwIfCoordinatorInReadBackoff(COORDINATOR)).not.toThrow();

		vi.stubGlobal('document', { visibilityState: 'visible' });
		markCoordinatorDegraded(COORDINATOR, 'Coordinator request timed out after 20000ms');
		expect(() => throwIfCoordinatorInReadBackoff(COORDINATOR)).toThrow(/unreachable/);
	});

	test('a backward clock step expires the window instead of extending it', () => {
		markCoordinatorDegraded(COORDINATOR, 'offline');
		vi.advanceTimersByTime(30_000);
		expect(() => throwIfCoordinatorInReadBackoff(COORDINATOR)).toThrow(/unreachable/);
		// NTP steps the clock back two minutes: the window must expire now
		// (worst case: one extra real RPC), not stretch to Δ + 60s.
		vi.setSystemTime(Date.now() - 120_000);
		expect(() => throwIfCoordinatorInReadBackoff(COORDINATOR)).not.toThrow();
	});

	test('the window expires 60 seconds after the mark', () => {
		markCoordinatorDegraded(COORDINATOR, 'offline');
		vi.advanceTimersByTime(59_000);
		expect(() => throwIfCoordinatorInReadBackoff(COORDINATOR)).toThrow(/unreachable/);
		vi.advanceTimersByTime(2_000);
		expect(() => throwIfCoordinatorInReadBackoff(COORDINATOR)).not.toThrow();
	});
});
