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
	coordinatorHealthStore.byCoordinator.set(normalizePubKey(coordinatorKey), next);
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
		lastError: error
	});
}

export function resetCoordinatorHealth(coordinatorKey: string) {
	coordinatorHealthStore.byCoordinator.delete(normalizePubKey(coordinatorKey));
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
