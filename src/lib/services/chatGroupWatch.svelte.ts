import { browser } from '$app/environment';
import { manager } from '$lib/services/accountManager.svelte';
import {
	decodeStoredGroupState,
	getChatGroup,
	isChatGroupRemoved,
	listChatGroups,
	ingestIncomingChatGroupMessages
} from '$lib/services/chatGroups.svelte';
import {
	disconnectCoordinatorClients,
	getCoordinatorClient,
	requireActiveAccount
} from '$lib/services/chatRuntime';

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

const currentWatches = new Map<string, GroupWatchTask>();
const autoWatchDisabledGroupIds = new Set<string>();
let lastActiveAccountId = '';
const groupIdDecoder = new TextDecoder();

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

		void stopWatchingGroup(undefined, 'active account changed');
		if (previousAccount) {
			void disconnectCoordinatorClients(previousAccount);
		}
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
	const client = getCoordinatorClient(account, group.coordinatorKey);
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
		const subscription = await client.SubscribeGroupMessages({
			gid,
			after
		});

		handle.task = (async () => {
			void subscription.result.catch((error) => {
				const detail = error instanceof Error ? error.message : String(error);
				if (closing && isExpectedAbort(detail, expectedAbortReason)) {
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
					if (isExpectedAbort(detail, reason)) {
						return;
					}

					chatGroupWatchStore.error =
						error instanceof Error ? error.message : 'Failed to stop watching group messages';
				});
			};

			try {
				for await (const message of subscription.stream) {
					const result = await ingestIncomingChatGroupMessages(groupId, [
						{
							cursor: message.cursor,
							createdAt: message.at,
							opaqueMessageBase64: message.msg_64
						}
					]);
					if (isChatGroupRemoved(result.group)) {
						await abort('removed from group');
						return;
					}
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				if (isExpectedAbort(detail, expectedAbortReason)) {
					return;
				}

				throw error;
			} finally {
				clearCurrentWatch(handle);
			}
		})();

		void handle.task.catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			if (isExpectedAbort(detail, expectedAbortReason)) {
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
	await Promise.allSettled(
		groups
			.filter(
				(group) =>
					getCurrentWatch(group.id) === undefined &&
					!autoWatchDisabledGroupIds.has(group.id) &&
					!isChatGroupRemoved(group)
			)
			.map((group) => startWatchingGroup(group.id))
	);
}
