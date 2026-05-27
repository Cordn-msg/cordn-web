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
	groupId: string;
	abort: (reason?: string) => Promise<void>;
	ready: Promise<void>;
	task: Promise<void>;
};

export const chatGroupWatchStore = $state<{
	watchingGroupIds: string[];
	error: string;
}>({
	watchingGroupIds: [],
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

	const active = currentWatches.get(handle.groupId);
	if (active === handle) {
		currentWatches.delete(handle.groupId);
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

		await Promise.allSettled(
			watchedGroupIds
				.filter((groupId) => {
					const group = getChatGroup(groupId);
					return group && !isChatGroupRemoved(group) && !autoWatchDisabledGroupIds.has(groupId);
				})
				.map((groupId) => startWatchingGroup(groupId))
		);

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
		const watches = [...currentWatches.values()];
		autoWatchDisabledGroupIds.clear();
		clearCurrentWatch();
		return Promise.all(watches.map((entry) => closeWatch(entry, reason)));
	}

	if (!watch) {
		return Promise.resolve();
	}

	return closeWatch(watch, reason);
}

export async function startWatchingGroup(groupId: string) {
	const existingWatch = getCurrentWatch(groupId);
	if (existingWatch) {
		return existingWatch.task;
	}

	autoWatchDisabledGroupIds.delete(groupId);

	const account = requireActiveAccount('You must be logged in to watch group messages');
	const group = getChatGroup(groupId);
	if (!group) {
		throw new Error('Group not found');
	}
	if (isChatGroupRemoved(group)) {
		return;
	}

	const state = decodeStoredGroupState(group);
	const gid = groupIdDecoder.decode(state.groupContext.groupId);
	const after = group.fetchCursor > 0 ? group.fetchCursor : undefined;

	chatGroupWatchStore.error = '';

	let abort: (reason?: string) => Promise<void> = async () => undefined;
	let expectedAbortReason: string | undefined;
	let closing = false;
	const handle: GroupWatchTask = {
		groupId,
		abort: async (reason?: string) => abort(reason),
		ready: Promise.resolve(),
		task: Promise.resolve()
	};

	handle.ready = (async () => {
		const subscription = await withCoordinatorClient(account, group.coordinatorKey, (client) =>
			client.SubscribeGroupMessages({
				gid,
				after
			})
		);

		handle.task = (async () => {
			const pendingMessages: WatchIncomingMessage[] = [];
			let flushTimer: ReturnType<typeof setTimeout> | undefined;
			let flushPromise = Promise.resolve(false);

			const reportFlushError = (error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				if (isExpectedWatchTeardown(detail, expectedAbortReason)) {
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

			const flushPendingMessages = () => {
				flushPromise = flushPromise.then(async () => {
					clearFlushTimer();
					if (pendingMessages.length === 0) return false;

					const batch = pendingMessages.splice(0, pendingMessages.length);
					const result = await ingestIncomingChatGroupMessages(groupId, batch);
					if (isChatGroupRemoved(result.group)) {
						await abort('removed from group');
						return true;
					}

					return false;
				});
				return flushPromise;
			};

			const scheduleFlush = () => {
				if (flushTimer) return;
				flushTimer = setTimeout(() => {
					flushTimer = undefined;
					void flushPendingMessages().catch(reportFlushError);
				}, WATCH_INGEST_FLUSH_MS);
			};

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
					pendingMessages.push({
						cursor: message.cursor,
						createdAt: message.at,
						opaqueMessageBase64: message.msg_64
					});

					if (pendingMessages.length >= WATCH_INGEST_BATCH_SIZE) {
						if (await flushPendingMessages()) {
							return;
						}
					} else {
						scheduleFlush();
					}
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				if (isExpectedWatchTeardown(detail, expectedAbortReason)) {
					return;
				}

				throw error;
			} finally {
				await flushPendingMessages().catch(() => undefined);
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

export async function startWatchingAllGroups() {
	const groups = listChatGroups();
	const groupsToWatch = groups.filter(
		(group) =>
			getCurrentWatch(group.id) === undefined &&
			!autoWatchDisabledGroupIds.has(group.id) &&
			!isChatGroupRemoved(group)
	);

	for (const group of groupsToWatch) {
		await startWatchingGroup(group.id).catch((error) => {
			console.warn('Failed to start group watch', group.id, error);
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
