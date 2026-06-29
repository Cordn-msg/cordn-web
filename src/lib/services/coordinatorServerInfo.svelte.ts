import { SvelteMap } from 'svelte/reactivity';
import { normalizePubKey } from '$lib/utils';
import type { CoordinatorServerInfo } from './coordinatorClient';

/**
 * Server-announced coordinator metadata (name/about/website/picture) learned
 * from real coordinator responses, mirroring `coordinatorHealthStore`. Like
 * health, this is observed and ephemeral — never polled for, never persisted.
 * It is harvested as a side-effect of routine coordinator calls via the
 * `onServerInfo` callback on `cordnClient`.
 */
export const coordinatorServerInfoStore = $state<{
	byCoordinator: SvelteMap<string, CoordinatorServerInfo>;
}>({
	byCoordinator: new SvelteMap()
});

export function setCoordinatorServerInfo(coordinatorKey: string, info: CoordinatorServerInfo) {
	coordinatorServerInfoStore.byCoordinator.set(normalizePubKey(coordinatorKey), info);
}

export function resetCoordinatorServerInfo(coordinatorKey: string) {
	coordinatorServerInfoStore.byCoordinator.delete(normalizePubKey(coordinatorKey));
}

export function getCoordinatorServerInfo(coordinatorKey: string): CoordinatorServerInfo {
	return coordinatorServerInfoStore.byCoordinator.get(normalizePubKey(coordinatorKey)) ?? {};
}

export function getCoordinatorServerName(coordinatorKey: string): string | undefined {
	return getCoordinatorServerInfo(coordinatorKey).name;
}
