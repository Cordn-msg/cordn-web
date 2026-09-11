import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { accountManagerMock, queryClientMock, coordinatorMock } = vi.hoisted(() => ({
	accountManagerMock: { getActive: vi.fn() },
	queryClientMock: { cancelQueries: vi.fn(), invalidateQueries: vi.fn() },
	coordinatorMock: vi.fn()
}));

vi.mock('$app/environment', () => ({ browser: false, dev: false }));
vi.mock('$lib/services/accountManager.svelte', () => ({ manager: accountManagerMock }));
vi.mock('$lib/services/chatCoordinators.svelte', () => ({ getChatCoordinator: coordinatorMock }));
vi.mock('$lib/query-client', () => ({ queryClient: queryClientMock }));
vi.mock('$lib/services/relay-pool', () => ({ defaultRelays: [] }));
vi.mock('$lib/services/coordinatorClient', () => {
	class StubCordnClient {
		private lifecycle = new AbortController();
		signal = this.lifecycle.signal;
		relays: string[];
		isSigning = false;
		constructor(options: { relays: string[] }) {
			this.relays = options.relays;
		}
		get isClosed() {
			return this.signal.aborted;
		}
		disconnect = vi.fn(async () => {
			this.lifecycle.abort(new Error('Connection closed'));
		});
	}
	return { cordnClient: StubCordnClient };
});

import {
	disconnectCoordinatorClients,
	getCoordinatorClient,
	rebuildAllCoordinatorClients,
	replaceCoordinatorClient,
	withCoordinatorClient,
	withCoordinatorClientRetry
} from './chatRuntime';

const ACCOUNT = { id: 'acc-1', pubkey: 'aa'.repeat(32), signer: {} } as never;
const COORDINATOR = 'bb'.repeat(32);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
	accountManagerMock.getActive.mockReturnValue(ACCOUNT);
	coordinatorMock.mockReturnValue({ relays: ['wss://one.invalid'] });
});

afterEach(async () => {
	await disconnectCoordinatorClients(ACCOUNT);
	vi.useRealTimers();
});

describe('coordinator client ownership', () => {
	test('a stalled read cannot block a send to the same coordinator', async () => {
		const pending = deferred<string>();
		const first = withCoordinatorClient(ACCOUNT, COORDINATOR, () => pending.promise);
		await expect(withCoordinatorClient(ACCOUNT, COORDINATOR, async () => 'sent')).resolves.toBe(
			'sent'
		);
		pending.resolve('read');
		await expect(first).resolves.toBe('read');
	});

	test('retired operations cannot block or replace the fresh client', async () => {
		const pending = deferred<string>();
		const first = withCoordinatorClient(ACCOUNT, COORDINATOR, () => pending.promise);
		const failed = expect(first).rejects.toThrow('Connection closed');
		const old = getCoordinatorClient(ACCOUNT, COORDINATOR);
		replaceCoordinatorClient(COORDINATOR, ACCOUNT, old);
		const fresh = getCoordinatorClient(ACCOUNT, COORDINATOR);
		await expect(withCoordinatorClient(ACCOUNT, COORDINATOR, async () => 'fresh')).resolves.toBe(
			'fresh'
		);
		pending.resolve('stale');
		await failed;
		expect(getCoordinatorClient(ACCOUNT, COORDINATOR)).toBe(fresh);
		expect(fresh).not.toBe(old);
	});

	test('a lost mutation response is not automatically replayed', async () => {
		const mutate = vi.fn(async () => {
			throw new Error('Request timed out');
		});
		const old = getCoordinatorClient(ACCOUNT, COORDINATOR);
		await expect(withCoordinatorClientRetry(ACCOUNT, COORDINATOR, mutate)).rejects.toThrow(
			'timed out'
		);
		expect(mutate).toHaveBeenCalledTimes(1);
		expect(getCoordinatorClient(ACCOUNT, COORDINATOR)).not.toBe(old);
	});

	test('known not-signed failures can retry on a fresh client', async () => {
		vi.useFakeTimers();
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error('Signer extension missing'))
			.mockResolvedValue('signed');
		const result = withCoordinatorClientRetry(ACCOUNT, COORDINATOR, operation);
		await vi.advanceTimersByTimeAsync(500);
		await expect(result).resolves.toBe('signed');
		expect(operation).toHaveBeenCalledTimes(2);
		expect(operation.mock.calls[0][0]).not.toBe(operation.mock.calls[1][0]);
	});

	test('query cancellation discards results without disrupting other operations', async () => {
		const pending = deferred<string>();
		const cancellation = new AbortController();
		const first = withCoordinatorClient(ACCOUNT, COORDINATOR, () => pending.promise, {
			signal: cancellation.signal
		});
		const failed = expect(first).rejects.toMatchObject({ name: 'AbortError' });
		const client = getCoordinatorClient(ACCOUNT, COORDINATOR);
		cancellation.abort();
		pending.resolve('obsolete');
		await failed;
		expect(getCoordinatorClient(ACCOUNT, COORDINATOR)).toBe(client);
	});

	test('old account operations cannot commit or recreate its registry', async () => {
		const pending = deferred<string>();
		const first = withCoordinatorClient(ACCOUNT, COORDINATOR, () => pending.promise);
		const failed = expect(first).rejects.toMatchObject({ name: 'AbortError' });
		accountManagerMock.getActive.mockReturnValue(undefined);
		await disconnectCoordinatorClients(ACCOUNT);
		pending.reject(new Error('Connection closed'));
		await failed;
		const operation = vi.fn();
		await expect(withCoordinatorClient(ACCOUNT, COORDINATOR, operation)).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(operation).not.toHaveBeenCalled();
	});

	test('a rapid account switch back survives the previous registry teardown', async () => {
		const old = getCoordinatorClient(ACCOUNT, COORDINATOR);
		const closing = deferred<void>();
		vi.mocked(old.disconnect).mockImplementation(() => closing.promise);
		const teardown = disconnectCoordinatorClients(ACCOUNT);
		const fresh = getCoordinatorClient(ACCOUNT, COORDINATOR);
		closing.resolve();
		await teardown;
		expect(fresh).not.toBe(old);
		expect(getCoordinatorClient(ACCOUNT, COORDINATOR)).toBe(fresh);
	});

	test('relay edits replace the cached client on next use', () => {
		const old = getCoordinatorClient(ACCOUNT, COORDINATOR);
		coordinatorMock.mockReturnValue({ relays: ['wss://two.invalid'] });
		expect(getCoordinatorClient(ACCOUNT, COORDINATOR)).not.toBe(old);
		expect(old.disconnect).toHaveBeenCalled();
	});

	test('foreground reset cancels reads, replaces clients and invalidates retained data', () => {
		const old = getCoordinatorClient(ACCOUNT, COORDINATOR);
		rebuildAllCoordinatorClients(ACCOUNT);
		expect(queryClientMock.cancelQueries).toHaveBeenCalledWith({
			queryKey: ['chat', 'account', 'aa'.repeat(32), 'coordinators']
		});
		expect(queryClientMock.invalidateQueries).toHaveBeenCalledWith(
			queryClientMock.cancelQueries.mock.calls[0][0]
		);
		expect(getCoordinatorClient(ACCOUNT, COORDINATOR)).not.toBe(old);
		expect(old.isClosed).toBe(true);
	});
});
