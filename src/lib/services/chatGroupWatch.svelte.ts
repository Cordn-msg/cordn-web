import { browser } from '$app/environment';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { manager } from '$lib/services/accountManager.svelte';
import {
	decodeStoredGroupState,
	fetchChatGroupMessages,
	getChatGroup,
	isChatGroupRemoved,
	listChatGroups,
	ingestIncomingChatGroupMessages,
	reloadChatGroupsForOwner
} from '$lib/services/chatGroups.svelte';
import {
	requestCoordinatorClientsRefresh,
	disconnectCoordinatorClients,
	isTransientCoordinatorError,
	onCoordinatorClientsRefresh,
	requireActiveAccount,
	withCoordinatorClient
} from '$lib/services/chatRuntime';
import { setChatReconnectStatus } from '$lib/services/chatReconnectStatus.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { loadChatGroupPresenceForOwner } from '$lib/services/chatGroupPresence.svelte';
import { loadWelcomeNotificationsForOwner } from '$lib/services/chatWelcomeNotifications.svelte';
import { normalizePubKey } from '$lib/utils';

type GroupWatchTask = {
	groupIds: string[];
	abort: (reason?: string) => Promise<void>;
	ready: Promise<void>;
	task: Promise<void>;
};

export const chatGroupWatchStore = $state<{
	watchingGroupIds: string[];
	startup: 'idle' | 'starting' | 'ready' | 'error';
	error: string;
}>({
	watchingGroupIds: [],
	startup: 'idle',
	error: ''
});

const currentWatches = new SvelteMap<string, GroupWatchTask>();
const autoWatchDisabledGroupIds = new SvelteSet<string>();
let lastActiveAccountId = '';
const groupIdDecoder = new TextDecoder();
const COORDINATOR_CLIENTS_REFRESHED_REASON = 'coordinator clients refreshed';
const WATCH_INGEST_BATCH_SIZE = 50;
const WATCH_INGEST_FLUSH_MS = 50;

type WatchIncomingMessage = {
	cursor: number;
	createdAt: number;
	opaqueMessageBase64: string;
};

function syncWatchingGroupIds() {
	chatGroupWatchStore.watchingGroupIds = [...currentWatches.keys()];
}

function getCurrentWatch(groupId: string) {
	return currentWatches.get(groupId);
}

function clearCurrentWatch(handle?: GroupWatchTask | null) {
	if (!handle) {
		currentWatches.clear();
		syncWatchingGroupIds();
		return;
	}

	let changed = false;
	for (const groupId of handle.groupIds) {
		const active = currentWatches.get(groupId);
		if (active !== handle) continue;
		currentWatches.delete(groupId);
		changed = true;
	}

	if (changed) {
		syncWatchingGroupIds();
	}
}

if (browser) {
	manager.active$.subscribe((account) => {
		const nextAccountId = account?.id ?? '';
		if (nextAccountId === lastActiveAccountId) {
			return;
		}

		const previousAccount = manager.getAccount(lastActiveAccountId);
		lastActiveAccountId = nextAccountId;
		autoWatchDisabledGroupIds.clear();
		chatGroupWatchStore.startup = 'idle';
		const nextOwnerPubkey = account ? normalizePubKey(account.pubkey) : undefined;
		loadChatGroupPresenceForOwner(nextOwnerPubkey);
		loadWelcomeNotificationsForOwner(nextOwnerPubkey);
		void reloadChatGroupsForOwner(nextOwnerPubkey);

		void stopWatchingGroup(undefined, 'active account changed');
		if (previousAccount) {
			queryClient.removeQueries({ queryKey: chatQueryKeys.account(previousAccount.pubkey) });
			void disconnectCoordinatorClients(previousAccount);
		}
	});

	onCoordinatorClientsRefresh(async (refreshClients) => {
		const watchedGroupIds = [...currentWatches.keys()];
		const watchedGroups = watchedGroupIds
			.map((groupId) => getChatGroup(groupId))
			.filter((group): group is NonNullable<typeof group> => Boolean(group));
		const activeCoordinatorKeys = watchedGroups.map((group) => group.coordinatorKey);

		if (watchedGroupIds.length > 0) {
			chatGroupWatchStore.error = '';
			setChatReconnectStatus({
				phase: 'syncing',
				message: 'Updating chats…',
				activeCoordinatorKeys
			});
			await stopWatchingGroup(undefined, COORDINATOR_CLIENTS_REFRESHED_REASON);
		}

		await refreshClients();

		if (watchedGroupIds.length === 0) {
			return;
		}

		await startWatchingAllGroups();

		await Promise.allSettled(watchedGroupIds.map((groupId) => fetchChatGroupMessages(groupId)));

		chatGroupWatchStore.error = '';
	});
}

export function isWatchingGroup(groupId?: string): boolean {
	return groupId ? getCurrentWatch(groupId) !== undefined : false;
}

async function closeWatch(handle: GroupWatchTask, reason: string) {
	await handle.abort(reason).catch(() => undefined);
	void handle.task.catch(() => undefined);
}

function isExpectedAbort(detail: string, reason?: string) {
	return reason !== undefined && detail === `Open stream aborted: ${reason}`;
}

function isExpectedWatchTeardown(detail: string, reason?: string) {
	if (isExpectedAbort(detail, reason)) {
		return true;
	}

	return (
		reason === COORDINATOR_CLIENTS_REFRESHED_REASON &&
		(detail.includes('Connection closed') || detail.includes('Failed to publish event'))
	);
}

export function stopWatchingGroup(groupId?: string, reason = 'user stopped watching') {
	const watch = groupId ? (currentWatches.get(groupId) ?? null) : null;
	if (groupId && reason === 'user stopped watching') {
		autoWatchDisabledGroupIds.add(groupId);
	}

	if (groupId) {
		clearCurrentWatch(watch);
	} else {
		const watches = [...currentWatches.values()].filter(
			(watch, index, allWatches) => allWatches.indexOf(watch) === index
		);
		autoWatchDisabledGroupIds.clear();
		clearCurrentWatch();
		return Promise.all(watches.map((entry) => closeWatch(entry, reason)));
	}

	if (!watch) {
		return Promise.resolve();
	}

	return closeWatch(watch, reason).then(() => {
		if (reason === 'user stopped watching') {
			void startWatchingAllGroups();
		}
	});
}

type WatchableGroup = {
	id: string;
	coordinatorKey: string;
	gid: string;
	after?: number;
};

function toWatchableGroup(groupId: string): WatchableGroup | null {
	const group = getChatGroup(groupId);
	if (!group || isChatGroupRemoved(group)) {
		return null;
	}

	const state = decodeStoredGroupState(group);
	return {
		id: group.id,
		coordinatorKey: group.coordinatorKey,
		gid: groupIdDecoder.decode(state.groupContext.groupId),
		after: group.fetchCursor > 0 ? group.fetchCursor : undefined
	};
}

function createWatchBuffer(input: {
	groupId: string;
	getExpectedAbortReason: () => string | undefined;
	abort: (reason?: string) => Promise<void>;
}) {
	const pendingMessages: WatchIncomingMessage[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let flushPromise = Promise.resolve(false);

	const reportFlushError = (error: unknown) => {
		const detail = error instanceof Error ? error.message : String(error);
		if (isExpectedWatchTeardown(detail, input.getExpectedAbortReason())) {
			return;
		}

		chatGroupWatchStore.error =
			error instanceof Error ? error.message : 'Failed to ingest watched group messages';
	};

	const clearFlushTimer = () => {
		if (!flushTimer) return;
		clearTimeout(flushTimer);
		flushTimer = undefined;
	};

	const flush = () => {
		flushPromise = flushPromise.then(async () => {
			clearFlushTimer();
			if (pendingMessages.length === 0) return false;

			const batch = pendingMessages.splice(0, pendingMessages.length);
			const result = await ingestIncomingChatGroupMessages(input.groupId, batch);
			if (isChatGroupRemoved(result.group)) {
				await input.abort('removed from group');
				return true;
			}

			return false;
		});
		return flushPromise;
	};

	return {
		push(message: WatchIncomingMessage) {
			pendingMessages.push(message);
			if (pendingMessages.length >= WATCH_INGEST_BATCH_SIZE) {
				return flush();
			}

			if (!flushTimer) {
				flushTimer = setTimeout(() => {
					flushTimer = undefined;
					void flush().catch(reportFlushError);
				}, WATCH_INGEST_FLUSH_MS);
			}

			return Promise.resolve(false);
		},
		flush,
		clearFlushTimer
	};
}

export async function startWatchingGroup(groupId: string) {
	const existingWatch = getCurrentWatch(groupId);
	if (existingWatch) {
		return existingWatch.task;
	}

	autoWatchDisabledGroupIds.delete(groupId);

	const account = requireActiveAccount('You must be logged in to watch group messages');
	const watchableGroup = toWatchableGroup(groupId);
	if (!watchableGroup) {
		throw new Error('Group not found');
	}

	chatGroupWatchStore.error = '';

	let abort: (reason?: string) => Promise<void> = async () => undefined;
	let expectedAbortReason: string | undefined;
	let closing = false;
	const handle: GroupWatchTask = {
		groupIds: [groupId],
		abort: async (reason?: string) => abort(reason),
		ready: Promise.resolve(),
		task: Promise.resolve()
	};

	handle.ready = (async () => {
		const subscription = await withCoordinatorClient(
			account,
			watchableGroup.coordinatorKey,
			(client) =>
				client.SubscribeGroupMessages({
					gid: watchableGroup.gid,
					after: watchableGroup.after
				})
		);

		handle.task = (async () => {
			const buffer = createWatchBuffer({
				groupId,
				getExpectedAbortReason: () => expectedAbortReason,
				abort: async (reason?: string) => abort(reason)
			});

			void subscription.result.catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				if (closing && isExpectedWatchTeardown(detail, expectedAbortReason)) {
					return;
				}
				if (isTransientCoordinatorError(error)) {
					void requestCoordinatorClientsRefresh();
					return;
				}

				chatGroupWatchStore.error =
					error instanceof Error ? error.message : 'Failed to watch group messages';
			});

			abort = (reason?: string) => {
				expectedAbortReason = reason;
				closing = true;

				return subscription.abort(reason).catch((error) => {
					const detail = error instanceof Error ? error.message : String(error);
					if (isExpectedWatchTeardown(detail, reason)) {
						return;
					}

					chatGroupWatchStore.error =
						error instanceof Error ? error.message : 'Failed to stop watching group messages';
				});
			};

			try {
				for await (const message of subscription.stream) {
					if (
						await buffer.push({
							cursor: message.cursor,
							createdAt: message.at,
							opaqueMessageBase64: message.msg_64
						})
					) {
						return;
					}
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				if (isExpectedWatchTeardown(detail, expectedAbortReason)) {
					return;
				}

				throw error;
			} finally {
				await buffer.flush().catch(() => undefined);
				buffer.clearFlushTimer();
				clearCurrentWatch(handle);
			}
		})();

		void handle.task.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			if (isExpectedWatchTeardown(detail, expectedAbortReason)) {
				return;
			}

			if (isTransientCoordinatorError(error)) {
				void requestCoordinatorClientsRefresh();
				return;
			}

			chatGroupWatchStore.error =
				error instanceof Error ? error.message : 'Failed to watch group messages';
			clearCurrentWatch(handle);
		});
	})();

	currentWatches.set(groupId, handle);
	syncWatchingGroupIds();

	return handle.ready;
}

async function startWatchingCoordinatorGroups(groups: WatchableGroup[]) {
	if (groups.length === 0) return;

	const account = requireActiveAccount('You must be logged in to watch group messages');
	const coordinatorKey = groups[0].coordinatorKey;
	const groupsByGid = new Map(groups.map((group) => [group.gid, group]));
	const groupIds = groups.map((group) => group.id);

	chatGroupWatchStore.error = '';

	let abort: (reason?: string) => Promise<void> = async () => undefined;
	let expectedAbortReason: string | undefined;
	let closing = false;
	const handle: GroupWatchTask = {
		groupIds,
		abort: async (reason?: string) => abort(reason),
		ready: Promise.resolve(),
		task: Promise.resolve()
	};

	handle.ready = (async () => {
		const subscription = await withCoordinatorClient(account, coordinatorKey, (client) =>
			client.SubscribeManyGroupMessages({
				groups: groups.map((group) => ({ gid: group.gid, after: group.after }))
			})
		);
		const buffers = new Map(
			groups.map((group) => [
				group.id,
				createWatchBuffer({
					groupId: group.id,
					getExpectedAbortReason: () => expectedAbortReason,
					abort: async (reason?: string) => abort(reason)
				})
			])
		);

		handle.task = (async () => {
			void subscription.result.catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				if (closing && isExpectedWatchTeardown(detail, expectedAbortReason)) {
					return;
				}
				if (isTransientCoordinatorError(error)) {
					void requestCoordinatorClientsRefresh();
					return;
				}

				chatGroupWatchStore.error =
					error instanceof Error ? error.message : 'Failed to watch group messages';
			});

			abort = (reason?: string) => {
				expectedAbortReason = reason;
				closing = true;

				return subscription.abort(reason).catch((error) => {
					const detail = error instanceof Error ? error.message : String(error);
					if (isExpectedWatchTeardown(detail, reason)) {
						return;
					}

					chatGroupWatchStore.error =
						error instanceof Error ? error.message : 'Failed to stop watching group messages';
				});
			};

			try {
				for await (const message of subscription.stream) {
					const group = groupsByGid.get(message.gid);
					const buffer = group ? buffers.get(group.id) : undefined;
					if (!buffer) continue;

					if (
						await buffer.push({
							cursor: message.cursor,
							createdAt: message.at,
							opaqueMessageBase64: message.msg_64
						})
					) {
						return;
					}
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				if (isExpectedWatchTeardown(detail, expectedAbortReason)) {
					return;
				}

				throw error;
			} finally {
				await Promise.all([...buffers.values()].map((buffer) => buffer.flush().catch(() => false)));
				for (const buffer of buffers.values()) {
					buffer.clearFlushTimer();
				}
				clearCurrentWatch(handle);
			}
		})();

		void handle.task.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			if (isExpectedWatchTeardown(detail, expectedAbortReason)) {
				return;
			}

			if (isTransientCoordinatorError(error)) {
				void requestCoordinatorClientsRefresh();
				return;
			}

			chatGroupWatchStore.error =
				error instanceof Error ? error.message : 'Failed to watch group messages';
			clearCurrentWatch(handle);
		});
	})();

	for (const groupId of groupIds) {
		currentWatches.set(groupId, handle);
	}
	syncWatchingGroupIds();

	return handle.ready;
}

export async function startWatchingAllGroups() {
	chatGroupWatchStore.startup = 'starting';
	const groupsToWatch = listChatGroups().filter(
		(group) =>
			getCurrentWatch(group.id) === undefined &&
			!autoWatchDisabledGroupIds.has(group.id) &&
			!isChatGroupRemoved(group)
	);
	if (groupsToWatch.length === 0) {
		chatGroupWatchStore.startup = 'ready';
		return;
	}

	const groupsByCoordinator = new SvelteMap<string, WatchableGroup[]>();

	for (const group of groupsToWatch) {
		const watchableGroup = toWatchableGroup(group.id);
		if (!watchableGroup) continue;
		const coordinatorGroups = groupsByCoordinator.get(watchableGroup.coordinatorKey) ?? [];
		coordinatorGroups.push(watchableGroup);
		groupsByCoordinator.set(watchableGroup.coordinatorKey, coordinatorGroups);
	}

	try {
		for (const [coordinatorKey, coordinatorGroups] of groupsByCoordinator) {
			await startWatchingCoordinatorGroups(coordinatorGroups).catch((error) => {
				console.warn('Failed to start coordinator group watch', coordinatorKey, error);
			});
		}
		chatGroupWatchStore.startup = 'ready';
	} catch (error) {
		chatGroupWatchStore.startup = 'error';
		throw error;
	}
}
