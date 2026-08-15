import { afterEach, describe, expect, it, vi } from 'vitest';
import { withConnectDeadline } from './coordinatorClient';
import { isTransientCoordinatorError } from './chatRuntime';

describe('withConnectDeadline', () => {
	afterEach(() => vi.useRealTimers());

	it('rejects with a transient timeout when the handshake never settles', async () => {
		vi.useFakeTimers();
		// A connect promise that stays pending forever, like the SDK's
		// initialize handshake retrying against unreachable relays.
		const pending = new Promise<void>(() => {});
		const guarded = withConnectDeadline(pending);
		const assertion = expect(guarded).rejects.toThrow(/timed out/);
		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
		// The timeout must classify as transient so the watch reconciler's
		// backoff + client-rebuild path handles it.
		await guarded.catch((error) => {
			expect(isTransientCoordinatorError(error)).toBe(true);
		});
	});

	it('passes through an already-settled connection immediately', async () => {
		await expect(withConnectDeadline(Promise.resolve())).resolves.toBeUndefined();
	});
});
