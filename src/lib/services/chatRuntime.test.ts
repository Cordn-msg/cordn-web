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
	type HealthSignal = { status: 'healthy' } | { status: 'degraded'; error: string };
	class StubCordnClient {
		private lifecycle = new AbortController();
		signal = this.lifecycle.signal;
		relays: string[];
		isSigning = false;
		onHealth?: (signal: HealthSignal) => void;
		constructor(options: { relays: string[]; onHealth?: (signal: HealthSignal) => void }) {
			this.relays = options.relays;
			this.onHealth = options.onHealth;
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
	probeCoordinatorClientPools,
	rebuildAllCoordinatorClients,
	replaceCoordinatorClient,
	resolveCoordinatorRelays,
	withCoordinatorClient,
	withCoordinatorClientRetry
} from './chatRuntime';
import { coordinatorHealthStore, getCoordinatorHealthTone } from './coordinatorHealth.svelte';

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

describe('resolveCoordinatorRelays', () => {
	test('returns the saved relay configuration; empty for unspecified (SDK resolves)', () => {
		// No blanket client-default fallback: a relay-less coordinator means
		// "unspecified" and flows to the transport's resolution chain.
		coordinatorMock.mockReturnValueOnce(undefined);
		expect(resolveCoordinatorRelays(COORDINATOR)).toEqual([]);
		coordinatorMock.mockReturnValueOnce({ relays: [] });
		expect(resolveCoordinatorRelays(COORDINATOR)).toEqual([]);
		const saved = ['wss://relay.example.com'];
		coordinatorMock.mockReturnValueOnce({ relays: saved });
		expect(resolveCoordinatorRelays(COORDINATOR)).toBe(saved);
	});
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
		const old = getCoordinatorClient(ACCOUNT, COORDINATOR);
		replaceCoordinatorClient(COORDINATOR, ACCOUNT, old);
		const fresh = getCoordinatorClient(ACCOUNT, COORDINATOR);
		await expect(withCoordinatorClient(ACCOUNT, COORDINATOR, async () => 'fresh')).resolves.toBe(
			'fresh'
		);
		// A COMPLETED call on a retired client resolves with its result instead
		// of being discarded as 'Connection closed': a finished msg_post has
		// landed — reporting success as failure breeds duplicate re-posts and
		// stuck queued bubbles. (A call still in flight when the client dies
		// still rejects via withDeadline's abort race.)
		pending.resolve('stale');
		await expect(first).resolves.toBe('stale');
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

describe('pool liveness probes', () => {
	test('attention events probe every live pool once per debounce window', async () => {
		const client = getCoordinatorClient(ACCOUNT, COORDINATOR);
		let probed = 0;
		const pool = {
			probe: vi.fn(async () => {
				probed += 1;
				return true;
			})
		};
		(client as unknown as { pool: unknown }).pool = pool;
		// A coordinator without an SDK pool (custom relayHandler injected) is
		// skipped without throwing.
		const COORDINATOR2 = 'cc'.repeat(32);
		const legacy = getCoordinatorClient(ACCOUNT, COORDINATOR2);
		(legacy as unknown as { pool: unknown }).pool = undefined;

		await probeCoordinatorClientPools('page visible');
		expect(probed).toBe(1);
		expect(pool.probe).toHaveBeenCalledTimes(1);

		// Burst of attention events inside the debounce window: one probe total.
		await probeCoordinatorClientPools('window focus');
		await probeCoordinatorClientPools('page resumed');
		expect(probed).toBe(1);
	});
});

describe('coordinator health marking', () => {
	type HealthSignal = { status: 'healthy' } | { status: 'degraded'; error: string };

	function emitHealth(client: unknown, signal: HealthSignal) {
		(client as { onHealth?: (signal: HealthSignal) => void }).onHealth?.(signal);
	}

	beforeEach(() => {
		coordinatorHealthStore.byCoordinator.clear();
	});

	test('only network-class failures mark the coordinator degraded', () => {
		const client = getCoordinatorClient(ACCOUNT, COORDINATOR);
		// Non-network failures are not reachability evidence: no degraded mark,
		// so no read breaker and no "Coordinator unreachable" for a healthy
		// coordinator (server application errors, contract parse failures,
		// signer-capability gaps).
		emitHealth(client, { status: 'degraded', error: 'Unrecognized key(s) in object: consumed' });
		expect(getCoordinatorHealthTone(COORDINATOR)).toBe('unknown');
		emitHealth(client, { status: 'degraded', error: 'Your signer does not support NIP-44 v2' });
		expect(getCoordinatorHealthTone(COORDINATOR)).toBe('unknown');
		emitHealth(client, {
			status: 'degraded',
			error: 'Coordinator request timed out after 20000ms'
		});
		expect(getCoordinatorHealthTone(COORDINATOR)).toBe('degraded');
		emitHealth(client, { status: 'healthy' });
		expect(getCoordinatorHealthTone(COORDINATOR)).toBe('healthy');
	});
});
