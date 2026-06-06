import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { accountManagerMock } = vi.hoisted(() => ({
	accountManagerMock: { getActive: vi.fn() }
}));

vi.mock('$app/environment', () => ({ browser: false, dev: false }));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: accountManagerMock
}));

vi.mock('$lib/services/coordinatorClient', () => {
	class StubCordnClient {
		disconnect = vi.fn().mockResolvedValue(undefined);
	}
	return { cordnClient: StubCordnClient, coordinatorClient: StubCordnClient };
});

vi.mock('$lib/services/relay-pool', () => ({
	defaultRelays: []
}));

import { getCoordinatorClient, withCoordinatorClient } from '$lib/services/chatRuntime';

const TEST_ACCOUNT = {
	id: 'acc-1',
	pubkey: 'aa'.repeat(32),
	signer: {}
} as never;

const COORDINATOR_A = 'bb'.repeat(32);
const COORDINATOR_B = 'cc'.repeat(32);

beforeEach(() => {
	accountManagerMock.getActive.mockReset();
	accountManagerMock.getActive.mockReturnValue(TEST_ACCOUNT);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('withCoordinatorClient() rebuild queue', () => {
	test('serializes operations for the same coordinator', async () => {
		const order: string[] = [];

		const first = withCoordinatorClient(TEST_ACCOUNT, COORDINATOR_A, async () => {
			order.push('first-start');
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push('first-end');
			return 'first';
		});

		const second = withCoordinatorClient(TEST_ACCOUNT, COORDINATOR_A, async () => {
			order.push('second');
			return 'second';
		});

		expect(order).toEqual([]);
		await Promise.all([first, second]);
		expect(order).toEqual(['first-start', 'first-end', 'second']);
	});

	test('operations for different coordinators are not blocked by each other', async () => {
		const order: string[] = [];

		const a = withCoordinatorClient(TEST_ACCOUNT, COORDINATOR_A, async () => {
			order.push('a-start');
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push('a-end');
			return 'a';
		});

		const b = withCoordinatorClient(TEST_ACCOUNT, COORDINATOR_B, async () => {
			order.push('b');
			return 'b';
		});

		await Promise.all([a, b]);
		expect(order[0]).toBe('a-start');
		expect(order[1]).toBe('b');
		expect(order[2]).toBe('a-end');
	});

	test('returns the operation result', async () => {
		const tag = Symbol('result');
		const result = await withCoordinatorClient(TEST_ACCOUNT, COORDINATOR_A, async () => tag);
		expect(result).toBe(tag);
		expect(getCoordinatorClient(TEST_ACCOUNT, COORDINATOR_A)).toBeDefined();
	});
});
