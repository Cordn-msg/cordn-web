import { SvelteMap } from 'svelte/reactivity';
import { normalizePubKey } from '$lib/utils';

/**
 * Observed coordinator reachability.
 *
 * Health is derived from real coordinator responses rather than inferred from
 * reconnect activity. A coordinator is only `healthy` after a coordinator call
 * has succeeded, `degraded` once a call or the CEP-41 open-stream keepalive
 * (probe timeout) reports a failure, and `unknown` until we have heard back at
 * all. The SDK already bounds every request and runs its own WebSocket + stream
 * keepalive, so this store only records what those layers report — it never
 * polls or invents its own heartbeat.
 */
export type CoordinatorHealthStatus = 'unknown' | 'healthy' | 'degraded';

export type CoordinatorHealth = {
	status: CoordinatorHealthStatus;
	lastError: string | undefined;
	/** Wall-clock ms of the most recent degraded mark; drives read backoff. */
	lastFailureAt?: number;
};

export const coordinatorHealthStore = $state<{
	byCoordinator: SvelteMap<string, CoordinatorHealth>;
}>({
	byCoordinator: new SvelteMap()
});

function readHealth(coordinatorKey: string): CoordinatorHealth {
	return (
		coordinatorHealthStore.byCoordinator.get(normalizePubKey(coordinatorKey)) ?? {
			status: 'unknown',
			lastError: undefined
		}
	);
}

function writeHealth(coordinatorKey: string, next: CoordinatorHealth) {
	const normalized = normalizePubKey(coordinatorKey);
	const previous = coordinatorHealthStore.byCoordinator.get(normalized);
	// No-op when unchanged: markCoordinatorHealthy fires after EVERY successful
	// coordinator call (posts, polls, heartbeat fetches), and an unconditional
	// reactive write invalidates every observer per RPC even when nothing
	// changed. Skipping identical writes keeps the reactive graph quiet.
	if (
		previous &&
		previous.status === next.status &&
		previous.lastError === next.lastError &&
		previous.lastFailureAt === next.lastFailureAt
	) {
		return;
	}
	coordinatorHealthStore.byCoordinator.set(normalized, next);
}

export function markCoordinatorHealthy(coordinatorKey: string) {
	writeHealth(coordinatorKey, {
		status: 'healthy',
		lastError: undefined
	});
}

export function markCoordinatorDegraded(coordinatorKey: string, error: string) {
	writeHealth(coordinatorKey, {
		status: 'degraded',
		lastError: error,
		lastFailureAt: Date.now()
	});
}

export function resetCoordinatorHealth(coordinatorKey: string) {
	const normalized = normalizePubKey(coordinatorKey);
	const previous = coordinatorHealthStore.byCoordinator.get(normalized);
	if (!previous) return;
	// A client swap is a fresh LOCAL identity, not evidence the server
	// recovered: keep the read-backoff memory so polling reads keep
	// fast-failing a hard-down coordinator across swaps (only a successful
	// call or window expiry lifts it).
	coordinatorHealthStore.byCoordinator.set(normalized, {
		status: 'unknown',
		lastError: undefined,
		lastFailureAt: previous.lastFailureAt
	});
}

export function getCoordinatorHealthTone(coordinatorKey: string): CoordinatorHealthStatus {
	return readHealth(coordinatorKey).status;
}

export function getCoordinatorHealthLabel(coordinatorKey: string): string {
	const health = readHealth(coordinatorKey);
	if (health.status === 'healthy') return 'Connected';
	if (health.status === 'degraded') return health.lastError ?? 'Connection issue';
	return 'Connecting…';
}

/** Read-backoff window: skip re-dialing a coordinator that just failed. */
const COORDINATOR_READ_BACKOFF_MS = 60_000;

/** Thrown by the read-backoff breaker ({@link throwIfCoordinatorInReadBackoff}). */
export class CoordinatorReadBackoffError extends Error {
	constructor() {
		super('Coordinator unreachable (recent failure; retrying soon)');
		this.name = 'CoordinatorReadBackoffError';
	}
}

/**
 * Read-seam circuit breaker. A coordinator that failed a call within the
 * backoff window is skipped by polling reads (key packages, welcomes, join
 * requests) instead of hanging to the RPC timeout every poll. Self-healing:
 * any successful call through the registry marks the coordinator healthy
 * (onHealth) and the window expires on its own — no probing added.
 *
 * Deliberately status-agnostic: client swaps reset the status to `unknown`
 * (replaceCoordinatorClient), and a swap is no evidence the server
 * recovered — only lastFailureAt decides.
 *
 * Throws (never "return empty") so the failure surfaces as a per-coordinator
 * query error while Svelte Query keeps serving stale cached data; an empty
 * success would wipe retained local state (e.g. welcome entries).
 */
export function throwIfCoordinatorInReadBackoff(coordinatorKey: string): void {
	const health = readHealth(coordinatorKey);
	if (
		health.lastFailureAt !== undefined &&
		Date.now() - health.lastFailureAt < COORDINATOR_READ_BACKOFF_MS
	) {
		throw new CoordinatorReadBackoffError();
	}
}

/**
 * Whether an error is the breaker doing its job (fast-fail) rather than a
 * real fetch failure — callers keep these quiet (console.debug) instead of
 * warning every poll for a permanently down coordinator. Identity check, not
 * message matching: immune to wrapping and message edits.
 */
export function isCoordinatorReadBackoffError(error: unknown): boolean {
	return error instanceof CoordinatorReadBackoffError;
}
