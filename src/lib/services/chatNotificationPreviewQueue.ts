import type { CordnBackgroundDrainResult } from 'cordn-background';

/**
 * Serialize warm preview passes while collapsing queued requests to the newest.
 * Fast and WorkManager polls can overlap; the shade should converge on the latest
 * staged cursor, not replay every intermediate batch or run two decrypts at once.
 */
export function createWarmPreviewQueue(
	deliver: (event: CordnBackgroundDrainResult) => Promise<void>
): (event: CordnBackgroundDrainResult) => Promise<void> {
	let inFlight: Promise<void> | null = null;
	let pending: CordnBackgroundDrainResult | null = null;

	function run(event: CordnBackgroundDrainResult): Promise<void> {
		pending = event;
		inFlight ??= (async () => {
			while (pending) {
				const next = pending;
				pending = null;
				try {
					await deliver(next);
				} catch (error) {
					console.warn('[notification-preview] warm pass failed', { error });
				}
			}
		})().finally(() => {
			inFlight = null;
			// A request that landed between the loop draining and this microtask
			// must not wait for the next poll.
			if (pending) void run(pending);
		});
		return inFlight;
	}

	return run;
}
