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
	const normalized = normalizePubKey(coordinatorKey);
	const previous = coordinatorServerInfoStore.byCoordinator.get(normalized);
	// No-op when unchanged: the onServerInfo harvest fires after every
	// successful coordinator call; an unconditional reactive write invalidates
	// observers per RPC for metadata that almost never changes.
	if (
		previous &&
		previous.name === info.name &&
		previous.about === info.about &&
		previous.website === info.website &&
		previous.picture === info.picture
	) {
		return;
	}
	coordinatorServerInfoStore.byCoordinator.set(normalized, info);
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
