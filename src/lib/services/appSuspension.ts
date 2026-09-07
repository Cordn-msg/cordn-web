/**
 * Suspension oracle: detects that the JS process was frozen/suspended while
 * the page was hidden (phone background, tab freeze, OS sleep). Freezing
 * pauses `performance.now()` while `Date.now()` keeps wall time, so
 * wall-clock elapsed minus monotonic elapsed ≈ time spent suspended.
 *
 * A live-but-throttled hidden tab (desktop streams still delivering,
 * notifications flowing) drifts ~0 and must be left alone.
 */
export type SuspensionStamps = {
	wall: number;
	mono: number;
};

export function suspensionDriftMs(
	stamps: SuspensionStamps,
	now: () => number = Date.now,
	mono: () => number = () => performance.now()
): number {
	return now() - stamps.wall - (mono() - stamps.mono);
}
