import { browser } from '$app/environment';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { manager } from '$lib/services/accountManager.svelte';
import {
	decodeStoredGroupState,
	getChatGroup,
	isChatGroupRemoved,
	isChatGroupPoisoned,
	listChatGroups,
	ingestIncomingChatGroupMessages,
	reloadChatGroupsForOwner
} from '$lib/services/chatGroups.svelte';
import {
	disconnectCoordinatorClients,
	isTransientCoordinatorError,
	requireActiveAccount,
	withCoordinatorClient
} from '$lib/services/chatRuntime';
import {
	clearChatReconnectStatus,
	failChatReconnectStatus,
	setChatReconnectStatus
} from '$lib/services/chatReconnectStatus.svelte';
import { markCoordinatorDegraded } from '$lib/services/coordinatorHealth.svelte';
import {
	startTipSubscription,
	stopTipSubscription,
	getMultiDeviceConfig
} from '$lib/services/multiDevice.svelte';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import {
	loadChatGroupPresenceForOwner,
	pruneChatGroupPresence
} from '$lib/services/chatGroupPresence.svelte';
import { loadWelcomeNotificationsForOwner } from '$lib/services/chatWelcomeNotifications.svelte';
import { loadJoinRequestsForOwner } from '$lib/services/chatJoinRequests.svelte';
import {
	markAllGroupsUnwatched,
	markGroupUnwatched,
	markGroupWatched,
	setChatGroupResumePromise
} from '$lib/services/chatGroupWatchStatus.svelte';
import { normalizePubKey } from '$lib/utils';

type GroupWatchTask = {
	groupIds: string[];
	coordinatorKey: string;
	/** Graceful teardown: marks closing and publishes an abort over the socket. */
	abort: (reason?: string) => Promise<void>;
	/** Local teardown: marks closing without any network publish (used by resume). */
	discard: () => void;
	ready: Promise<void>;
	task: Promise<void>;
};

export const chatGroupWatchStore = $state<{
	startup: 'idle' | 'starting' | 'ready' | 'error';
	error: string;
}>({
	startup: 'idle',
	error: ''
});

const currentWatches = new SvelteMap<string, GroupWatchTask>();
let lastActiveAccountId = '';
const groupIdDecoder = new TextDecoder();
const RUNTIME_RESUME_REASON = 'runtime resume';
const WATCH_INGEST_BATCH_SIZE = 50;
const WATCH_INGEST_FLUSH_MS = 0;
const RESUME_DEBOUNCE_MS = 500;
const MIN_RESUME_INTERVAL_MS = 5000;
/** Bounds graceful teardowns so an abort publish on an unhealthy socket can't hang forever. */
const CLOSE_WATCH_TIMEOUT_MS = 3000;
/** Hides the "Updating chats…" banner for rebuilds that finish quickly. */
const RECONNECT_BANNER_DELAY_MS = 500;
let resumePromise: Promise<void> | null = null;
let resumeEpoch = 0;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let lastSuccessfulResumeAt = 0;
/**
 * Set once the first watch startup has settled (success or failure). Before
 * this, the lifecycle listeners (pageshow/focus/visibilitychange) stay silent
 * so a fresh app open doesn't churn the watches the steady-state layout effect
 * is already starting (and doesn't flash the reconnect banner). Setting it on
 * failure too keeps foreground listeners able to retry a failed initial start.
 * `online` is exempt since it signals genuine connectivity recovery.
 */
let warmed = false;

type WatchIncomingMessage = {
	cursor: number;
	createdAt: number;
	opaqueMessageBase64: string;
	encrypted?: boolean;
};

type WatchFetchedMessage = WatchIncomingMessage & {
	gid: string;
};

function getCurrentWatch(groupId: string) {
	return currentWatches.get(groupId);
}

function clearCurrentWatch(handle?: GroupWatchTask | null) {
	if (!handle) {
		currentWatches.clear();
		markAllGroupsUnwatched();
		return;
	}

	for (const groupId of handle.groupIds) {
		if (currentWatches.get(groupId) === handle) {
			currentWatches.delete(groupId);
			markGroupUnwatched(groupId);
		}
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
		chatGroupWatchStore.startup = 'idle';
		const nextOwnerPubkey = account ? normalizePubKey(account.pubkey) : undefined;
		const groupLoadPromise = reloadChatGroupsForOwner(nextOwnerPubkey);
		loadChatGroupPresenceForOwner(nextOwnerPubkey);
		loadWelcomeNotificationsForOwner(nextOwnerPubkey);
		loadJoinRequestsForOwner(nextOwnerPubkey);

		void stopWatchingGroup(undefined, 'active account changed').then(async () => {
			await groupLoadPromise;
			pruneChatGroupPresence();
			if (account) {
				// Account switches converge on the same delta-based starter as the
				// steady-state layout effect instead of a stop-the-world resume, so the
				// two paths never race to open duplicate fetches/subscriptions.
				void startWatchingAllGroups();
				// Multi-device tip subscription follows the active account: stop the
				// previous owner's subscription, then start this one's if enabled.
				stopTipSubscription();
				if (getMultiDeviceConfig(account.pubkey)?.enabled) startTipSubscription();
			} else {
				stopTipSubscription();
			}
		});
		if (previousAccount) {
			queryClient.removeQueries({ queryKey: chatQueryKeys.account(previousAccount.pubkey) });
			void disconnectCoordinatorClients(previousAccount);
		}
	});

	const likelyMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

	window.addEventListener('online', () => scheduleChatGroupResume('browser online'));
	window.addEventListener('pageshow', () => {
		if (warmed) scheduleChatGroupResume('page show');
	});

	if (likelyMobile) {
		window.addEventListener('focus', () => {
			if (warmed) scheduleChatGroupResume('window focus');
		});
		document.addEventListener('visibilitychange', () => {
			if (warmed && document.visibilityState === 'visible') {
				scheduleChatGroupResume('page visible');
			}
		});
	}
}

async function closeWatch(
	handle: GroupWatchTask,
	reason: string,
	options: { local?: boolean } = {}
) {
	// Local teardown (resume) just marks the handle closing without any network
	// publish, so it never depends on socket health. Graceful teardown still
	// publishes an abort for prompt server-side cleanup, but is bounded so an
	// unhealthy socket can't hang teardown indefinitely.
	const teardown = (async () => {
		if (options.local) {
			// Local discard (resume): just mark closing. We don't await `ready`
			// because the client rebuild disconnects the socket, which interrupts
			// any in-flight fetch/subscribe whose rejection is handled by the
			// `closing` guard — awaiting it would just wait for that interruption.
			handle.discard();
		} else {
			// Graceful teardown: publish an abort for prompt server-side cleanup,
			// and await `ready` so a subscription resolving mid-abort actually gets
			// aborted by the post-resolve closing check.
			try {
				await handle.abort(reason);
			} catch {
				// Abort failures must not block teardown; the discarded socket is torn
				// down regardless once it falls out of scope.
			}
			try {
				await handle.ready;
			} catch {
				// Ready rejections (e.g. backlog fetch failure) are not teardown blockers.
			}
		}
	})();
	await Promise.race([
		teardown,
		new Promise((resolve) => setTimeout(resolve, CLOSE_WATCH_TIMEOUT_MS))
	]);
	void handle.task.catch(() => undefined);
}

function scheduleChatGroupResume(reason: string, coordinatorKey?: string) {
	if (resumeTimer) {
		clearTimeout(resumeTimer);
	}

	resumeTimer = setTimeout(() => {
		resumeTimer = null;
		void resumeChatGroupWatching(reason, coordinatorKey);
	}, RESUME_DEBOUNCE_MS);
}

export function stopWatchingGroup(
	groupId?: string,
	reason = 'group stopped',
	options: { local?: boolean } = {}
) {
	if (!groupId) {
		const watches = [...currentWatches.values()].filter(
			(watch, index, allWatches) => allWatches.indexOf(watch) === index
		);
		clearCurrentWatch();
		return Promise.all(watches.map((entry) => closeWatch(entry, reason, options)));
	}

	const watch = currentWatches.get(groupId) ?? null;
	clearCurrentWatch(watch);
	if (!watch) {
		return Promise.resolve();
	}
	return closeWatch(watch, reason, options);
}

function getWatchableGroups(input: { includeCurrentWatches: boolean }) {
	return listChatGroups()
		.filter(
			(group) =>
				(input.includeCurrentWatches || getCurrentWatch(group.id) === undefined) &&
				!isChatGroupRemoved(group) &&
				!isChatGroupPoisoned(group)
		)
		.map((group) => toWatchableGroup(group.id))
		.filter((group): group is WatchableGroup => Boolean(group));
}

function groupWatchableGroupsByCoordinator(groups: WatchableGroup[]) {
	const groupsByCoordinator = new SvelteMap<string, WatchableGroup[]>();

	for (const group of groups) {
		const coordinatorGroups = groupsByCoordinator.get(group.coordinatorKey) ?? [];
		coordinatorGroups.push(group);
		groupsByCoordinator.set(group.coordinatorKey, coordinatorGroups);
	}

	return groupsByCoordinator;
}

async function stopCoordinatorWatches(
	coordinatorKey: string | undefined,
	reason: string,
	options: { local?: boolean } = {}
) {
	// When a single coordinator degraded, only tear down that coordinator's
	// watches so healthy subscriptions on other coordinators are not disrupted.
	if (!coordinatorKey) {
		return stopWatchingGroup(undefined, reason, options);
	}

	const handlesToStop = new SvelteSet<GroupWatchTask>();
	for (const handle of currentWatches.values()) {
		if (handle.coordinatorKey === coordinatorKey) {
			handlesToStop.add(handle);
		}
	}
	for (const handle of handlesToStop) {
		clearCurrentWatch(handle);
	}
	await Promise.all([...handlesToStop].map((handle) => closeWatch(handle, reason, options)));
}

async function runResumeChatGroupWatching(reason: string, coordinatorKey?: string) {
	const account = manager.getActive();
	if (!account) {
		return;
	}

	chatGroupWatchStore.startup = 'starting';
	chatGroupWatchStore.error = '';

	// The banner is for connectivity recovery only, and only after the initial
	// watch has settled (fresh opens start silently via the layout effect). It
	// is delayed so a fast restart doesn't flash a useless banner.
	const showReconnectStatus = warmed && reason !== 'active account changed';
	let bannerTimer: ReturnType<typeof setTimeout> | undefined;
	if (showReconnectStatus) {
		bannerTimer = setTimeout(
			() => setChatReconnectStatus('Updating chats…'),
			RECONNECT_BANNER_DELAY_MS
		);
	}
	const clearBannerTimer = () => {
		if (bannerTimer) {
			clearTimeout(bannerTimer);
			bannerTimer = undefined;
		}
	};

	try {
		if (coordinatorKey) {
			// Scoped resume: that coordinator's subscription emitted a transient
			// error. Locally discard its watches (no abort publish — those hang on
			// an unhealthy relay) so the delta restart below re-opens them. We do
			// NOT rebuild the client: a transient stream error (timeout, momentary
			// close) does not mean the socket is dead, and forcing a full relay
			// reconnect + health reset here makes time-to-"Connected" scale with
			// group count on flaky mobile networks. `withCoordinatorClient` already
			// rebuilds lazily (via `replaceCoordinatorClient`) only if the restart's
			// backlog fetch actually fails on the current client, so a genuinely
			// dead socket is still recovered — without paying a reconnect on every
			// harmless blip.
			await stopCoordinatorWatches(coordinatorKey, RUNTIME_RESUME_REASON, { local: true });
		}
		// Delta restart: `startWatchingAllGroups` only opens backlog fetches and
		// subscriptions for groups not already in `currentWatches`. Subscriptions
		// that died while backgrounded (or were discarded by the scoped branch
		// above) unregister themselves on stream end, so this restarts exactly
		// those; healthy subscriptions are left untouched.
		await startWatchingAllGroups({ skipBacklogSync: false });
		lastSuccessfulResumeAt = Date.now();
		chatGroupWatchStore.startup = 'ready';
		clearBannerTimer();
		clearChatReconnectStatus();
	} catch (error) {
		chatGroupWatchStore.startup = 'error';
		chatGroupWatchStore.error = error instanceof Error ? error.message : 'Failed to update chats';
		clearBannerTimer();
		if (showReconnectStatus) {
			failChatReconnectStatus(chatGroupWatchStore.error);
		}
		throw error;
	} finally {
		// Arm lifecycle listeners after the first resume settles, including on
		// error, so a failed initial start can still be retried by foreground.
		warmed = true;
	}
}

export function resumeChatGroupWatching(reason = RUNTIME_RESUME_REASON, coordinatorKey?: string) {
	if (resumePromise) {
		return resumePromise;
	}

	if (
		Date.now() - lastSuccessfulResumeAt < MIN_RESUME_INTERVAL_MS &&
		reason !== 'active account changed'
	) {
		return Promise.resolve();
	}

	const epoch = ++resumeEpoch;
	resumePromise = runResumeChatGroupWatching(reason, coordinatorKey).finally(() => {
		if (resumeEpoch === epoch) {
			resumePromise = null;
			setChatGroupResumePromise(null);
		}
	});
	setChatGroupResumePromise(resumePromise, coordinatorKey);

	return resumePromise;
}

type WatchableGroup = {
	id: string;
	coordinatorKey: string;
	gid: string;
	after?: number;
	sinceEpoch?: string;
};

function toWatchableGroup(groupId: string): WatchableGroup | null {
	const group = getChatGroup(groupId);
	if (!group || isChatGroupRemoved(group) || isChatGroupPoisoned(group)) {
		return null;
	}

	const state = decodeStoredGroupState(group);
	const hasCursor = group.fetchCursor > 0;
	const gid = groupIdDecoder.decode(state.groupContext.groupId);
	const watchable: WatchableGroup = {
		id: group.id,
		coordinatorKey: group.coordinatorKey,
		gid
	};

	if (hasCursor) {
		watchable.after = group.fetchCursor;
	} else if (group.joinEpoch > 0n) {
		watchable.sinceEpoch = group.joinEpoch.toString();
	}

	return watchable;
}

function createWatchBuffer(input: {
	groupId: string;
	isClosing: () => boolean;
	abort: (reason?: string) => Promise<void>;
}) {
	const pendingMessages: WatchIncomingMessage[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let flushPromise = Promise.resolve(false);

	const reportFlushError = (error: unknown) => {
		if (input.isClosing()) {
			return;
		}
		const detail = error instanceof Error ? error.message : String(error);
		console.warn('[watch] failed to ingest watched group messages', {
			groupId: input.groupId,
			detail
		});
	};

	const clearFlushTimer = () => {
		if (!flushTimer) return;
		clearTimeout(flushTimer);
		flushTimer = undefined;
	};

	const flush = () => {
		flushPromise = flushPromise
			.catch((error) => {
				reportFlushError(error);
				return false;
			})
			.then(async () => {
				clearFlushTimer();
				if (pendingMessages.length === 0) return false;

				const batch = pendingMessages.splice(0, pendingMessages.length);
				const result = await ingestIncomingChatGroupMessages(input.groupId, batch);
				if (isChatGroupRemoved(result.group)) {
					await input.abort('removed from group');
					return true;
				}

				// Abort watch if group became poisoned
				if (isChatGroupPoisoned(result.group)) {
					await input.abort('group poisoned');
					return true;
				}

				return false;
			})
			.catch((error) => {
				reportFlushError(error);
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

async function ingestGroupMessagesFromCoordinatorFetch(
	groupsByGid: Map<string, WatchableGroup>,
	messages: WatchFetchedMessage[]
): Promise<Set<string>> {
	const messagesByGroupId = new SvelteMap<string, WatchIncomingMessage[]>();
	const failedGroupIds = new SvelteSet<string>();

	for (const message of messages) {
		const group = groupsByGid.get(message.gid);
		if (!group) continue;
		const groupMessages = messagesByGroupId.get(group.id) ?? [];
		groupMessages.push({
			cursor: message.cursor,
			createdAt: message.createdAt,
			opaqueMessageBase64: message.opaqueMessageBase64,
			encrypted: message.encrypted
		});
		messagesByGroupId.set(group.id, groupMessages);
	}

	for (const [groupId, groupMessages] of messagesByGroupId) {
		try {
			const result = await ingestIncomingChatGroupMessages(groupId, groupMessages);
			// Mark as failed if group became poisoned
			if (isChatGroupPoisoned(result.group)) {
				failedGroupIds.add(groupId);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn('[watch] failed to ingest coordinator backlog for group', {
				groupId,
				messageCount: groupMessages.length,
				detail
			});
			failedGroupIds.add(groupId);
		}
	}

	return failedGroupIds;
}

async function fetchCoordinatorGroupBacklog(input: {
	account: ReturnType<typeof requireActiveAccount>;
	coordinatorKey: string;
	groups: WatchableGroup[];
}): Promise<Set<string>> {
	const groupsByGid = new Map(input.groups.map((group) => [group.gid, group]));
	const result = await withCoordinatorClient(input.account, input.coordinatorKey, (client) =>
		client.FetchManyGroupMessages({
			groups: input.groups.map((group) => ({
				gid: group.gid,
				after: group.after,
				since_epoch: group.sinceEpoch
			}))
		})
	);
	if (result.messages.length === 0) return new Set<string>();

	return ingestGroupMessagesFromCoordinatorFetch(
		groupsByGid,
		result.messages.map((message) => ({
			gid: message.gid,
			cursor: message.cursor,
			createdAt: message.at,
			opaqueMessageBase64: message.msg_64,
			encrypted: message.encrypted
		}))
	);
}

async function startWatchingCoordinatorGroups(
	groups: WatchableGroup[],
	options: { skipBacklogSync?: boolean } = {}
) {
	if (groups.length === 0) return;

	const account = requireActiveAccount('You must be logged in to watch group messages');
	const coordinatorKey = groups[0].coordinatorKey;
	const groupIds = groups.map((group) => group.id);

	// `realAbort` is assigned once the subscription resolves. Until then, calls to
	// `handle.abort` only record intent (`closing = true`); the post-resolve
	// closing checks below abort the subscription (or skip creating it) so a
	// watch torn down mid-start can never leak an orphaned subscription.
	let realAbort: ((reason?: string) => Promise<void>) | undefined;
	let expectedAbortReason: string | undefined;
	let closing = false;
	// Set when teardown was initiated locally (resume) without an abort publish.
	// The post-resolve closing check then skips publishing on the discarded
	// socket; the client rebuild tears it down regardless.
	let localDiscard = false;
	const handle: GroupWatchTask = {
		groupIds,
		coordinatorKey,
		abort: async (reason?: string) => {
			closing = true;
			if (expectedAbortReason === undefined) expectedAbortReason = reason;
			if (realAbort) await realAbort(reason);
		},
		discard: () => {
			closing = true;
			localDiscard = true;
		},
		ready: Promise.resolve(),
		task: Promise.resolve()
	};

	// Register synchronously, before any await, so stopWatchingGroup can always
	// find and abort this handle during the backlog fetch / subscribe window.
	for (const groupId of groupIds) {
		currentWatches.set(groupId, handle);
		markGroupWatched(groupId);
	}

	handle.ready = (async () => {
		try {
			let failedGroupIds = new Set<string>();
			if (!options.skipBacklogSync && !closing) {
				failedGroupIds = await fetchCoordinatorGroupBacklog({ account, coordinatorKey, groups });
			}
			// Aborted during the backlog fetch — never open a subscription.
			if (closing) {
				clearCurrentWatch(handle);
				return;
			}
			const subscriptionGroups = groupIds
				.filter((groupId) => !failedGroupIds.has(groupId))
				.map((groupId) => toWatchableGroup(groupId))
				.filter((group): group is WatchableGroup => Boolean(group));
			if (subscriptionGroups.length === 0) {
				clearCurrentWatch(handle);
				return;
			}
			const groupsByGid = new Map(subscriptionGroups.map((group) => [group.gid, group]));
			const subscription = await withCoordinatorClient(account, coordinatorKey, (client) =>
				client.SubscribeManyGroupMessages({
					groups: subscriptionGroups.map((group) => ({
						gid: group.gid,
						after: group.after,
						since_epoch: group.sinceEpoch
					}))
				})
			);
			// Aborted while the subscribe request was in flight — tear it down
			// immediately instead of consuming its stream as an orphan. A local
			// discard (resume) skips the abort publish; the client rebuild closes
			// the socket regardless.
			if (closing) {
				if (!localDiscard) {
					await subscription.abort(expectedAbortReason).catch(() => undefined);
				}
				clearCurrentWatch(handle);
				return;
			}
			const buffers = new Map(
				subscriptionGroups.map((group) => [
					group.id,
					createWatchBuffer({
						groupId: group.id,
						isClosing: () => closing,
						abort: async (reason?: string) => handle.abort(reason)
					})
				])
			);

			realAbort = (reason?: string) => {
				expectedAbortReason = reason;
				closing = true;

				return subscription.abort(reason).catch((error) => {
					const detail = error instanceof Error ? error.message : String(error);
					console.warn('[watch] failed to stop watching group messages', {
						coordinatorKey,
						detail
					});
				});
			};

			handle.task = (async () => {
				void subscription.result.catch((error) => {
					if (closing) return;
					const detail = error instanceof Error ? error.message : String(error);
					if (isTransientCoordinatorError(error)) {
						markCoordinatorDegraded(coordinatorKey, detail);
						scheduleChatGroupResume('coordinator subscription result failed', coordinatorKey);
						return;
					}

					console.warn('[watch] coordinator subscription result failed', {
						coordinatorKey,
						detail
					});
				});

				try {
					for await (const message of subscription.stream) {
						const group = groupsByGid.get(message.gid);
						const buffer = group ? buffers.get(group.id) : undefined;
						if (!buffer) continue;

						if (
							await buffer.push({
								cursor: message.cursor,
								createdAt: message.at,
								opaqueMessageBase64: message.msg_64,
								encrypted: message.encrypted
							})
						) {
							return;
						}
					}
				} catch (error) {
					if (closing) return;
					throw error;
				} finally {
					await Promise.all(
						[...buffers.values()].map((buffer) => buffer.flush().catch(() => false))
					);
					for (const buffer of buffers.values()) {
						buffer.clearFlushTimer();
					}
					clearCurrentWatch(handle);
				}
			})();

			void handle.task.catch((error) => {
				if (closing) return;
				const detail = error instanceof Error ? error.message : String(error);
				if (isTransientCoordinatorError(error)) {
					markCoordinatorDegraded(coordinatorKey, detail);
					scheduleChatGroupResume('coordinator subscription stream failed', coordinatorKey);
					return;
				}

				console.warn('[watch] coordinator subscription stream failed', {
					coordinatorKey,
					detail
				});
				clearCurrentWatch(handle);
			});
		} catch (error) {
			// Backlog fetch or subscribe threw. If we were torn down mid-start
			// (abort or local discard), resolve cleanly instead of surfacing a
			// spurious start failure — the client rebuild closes the discarded
			// socket regardless, which can interrupt an in-flight fetch.
			clearCurrentWatch(handle);
			if (closing) return;
			throw error;
		}
	})();

	return handle.ready;
}

let startAllPromise: Promise<void> | null = null;
let startAllRequestedDuringRun = false;

async function runStartWatchingAllGroups(options: { skipBacklogSync?: boolean }) {
	try {
		const groupsToWatch = getWatchableGroups({ includeCurrentWatches: false });
		if (groupsToWatch.length === 0) {
			chatGroupWatchStore.startup = 'ready';
			return;
		}

		chatGroupWatchStore.startup = 'starting';
		const groupsByCoordinator = groupWatchableGroupsByCoordinator(groupsToWatch);

		await Promise.all(
			[...groupsByCoordinator].map(([coordinatorKey, coordinatorGroups]) =>
				startWatchingCoordinatorGroups(coordinatorGroups, options).catch((error) => {
					console.warn('Failed to start coordinator group watch', coordinatorKey, error);
				})
			)
		);
		chatGroupWatchStore.startup = 'ready';
	} catch (error) {
		chatGroupWatchStore.startup = 'error';
		throw error;
	} finally {
		// Arm lifecycle listeners after the first start settles (success or
		// failure) so a failed initial start can still be retried by foreground.
		warmed = true;
	}
}

/**
 * Single authoritative "ensure every watchable group is watched" entry point.
 *
 * Re-entrancy is guarded by a singleton promise so the two natural callers —
 * the account-change handler and the steady-state layout `$effect` — can never
 * race to open duplicate backlog fetches or subscriptions on a cold start.
 * `getWatchableGroups({ includeCurrentWatches: false })` plus synchronous
 * handle registration in `startWatchingCoordinatorGroups` make each run a pure
 * delta over the current watches, so a call that lands while another is in
 * flight simply re-evaluates the delta once (catching groups added concurrently
 * or watches cleared by a scoped resume) instead of duplicating work.
 */
export function startWatchingAllGroups(options: { skipBacklogSync?: boolean } = {}) {
	if (startAllPromise) {
		startAllRequestedDuringRun = true;
		return startAllPromise;
	}

	startAllPromise = (async () => {
		await runStartWatchingAllGroups(options);
		if (startAllRequestedDuringRun) {
			startAllRequestedDuringRun = false;
			await runStartWatchingAllGroups(options);
		}
	})()
		.catch((error) => {
			// runStartWatchingAllGroups logs per-coordinator failures; surface
			// unexpected throws without breaking the singleton guard.
			console.warn('Failed to start group watches', error);
		})
		.finally(() => {
			startAllPromise = null;
		});

	return startAllPromise;
}
