import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { rebuild, signing, native, setFocused, appListener, groups, client, unwatched } = vi.hoisted(
	() => ({
		rebuild: vi.fn(),
		signing: vi.fn(),
		native: vi.fn(),
		setFocused: vi.fn(),
		groups: vi.fn(),
		client: { current: undefined as unknown },
		unwatched: vi.fn(),
		appListener: { current: undefined as ((state: { isActive: boolean }) => void) | undefined }
	})
);
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('@capacitor/app', () => ({
	App: {
		addListener: vi.fn(async (_event, callback) => {
			appListener.current = callback;
		})
	}
}));
vi.mock('@tanstack/svelte-query', () => ({ focusManager: { setFocused } }));
vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: {
		getActive: () => ({ id: 'account', pubkey: 'aa'.repeat(32) }),
		active$: { subscribe: vi.fn() }
	}
}));
vi.mock('$lib/services/chatGroups.svelte', () => ({
	listChatGroups: groups,
	getChatGroup: (id: string) => groups().find((group: { id: string }) => group.id === id),
	isChatGroupRemoved: () => false,
	isChatGroupPoisoned: () => false,
	decodeStoredGroupState: () => ({ groupContext: { groupId: new TextEncoder().encode('group') } })
}));
vi.mock('$lib/services/chatRuntime', () => ({
	rebuildAllCoordinatorClients: rebuild,
	isCoordinatorSignerActive: signing,
	getCoordinatorClient: () => client.current,
	isCurrentCoordinatorClient: (_key: string, observed: unknown) => observed === client.current
}));
vi.mock('$lib/services/chatReconnectStatus.svelte', () => ({
	clearChatReconnectStatus: vi.fn(),
	failChatReconnectStatus: vi.fn(),
	setChatReconnectStatus: vi.fn()
}));
vi.mock('$lib/services/coordinatorHealth.svelte', () => ({
	getCoordinatorHealthTone: () => 'healthy'
}));
vi.mock('$lib/services/multiDevice.svelte', () => ({ awaitMultiDeviceReconciled: async () => {} }));
vi.mock('$lib/query-client', () => ({ queryClient: {} }));
vi.mock('$lib/queries/chatQueryKeys', () => ({ chatQueryKeys: {} }));
vi.mock('$lib/services/chatGroupPresence.svelte', () => ({}));
vi.mock('$lib/services/chatWelcomeNotifications.svelte', () => ({}));
vi.mock('$lib/services/chatJoinRequests.svelte', () => ({}));
vi.mock('$lib/services/nativeBridge', () => ({ isNativePlatform: native }));
vi.mock('$lib/services/chatGroupWatchStatus.svelte', () => ({
	setChatGroupResumePromise: vi.fn(),
	markGroupWatched: vi.fn(),
	markGroupUnwatched: unwatched,
	markAllGroupsUnwatched: vi.fn(),
	markGroupsBacklogComplete: vi.fn(),
	markGroupsBacklogIncomplete: vi.fn()
}));
vi.mock('$lib/services/signerReadiness.svelte', () => ({ ensureSignerReady: async () => true }));
vi.mock('$lib/utils', () => ({
	errorMessage: String,
	normalizePubKey: (key: string) => key
}));

let page: EventTarget & { visibilityState: string };
let win: EventTarget;
function visibility(state: string) {
	page.visibilityState = state;
	page.dispatchEvent(new Event('visibilitychange'));
}
async function start() {
	const watch = await import('./chatGroupWatch.svelte');
	await watch.startWatchingAllGroups();
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	native.mockReturnValue(false);
	signing.mockReturnValue(false);
	appListener.current = undefined;
	groups.mockReturnValue([]);
	client.current = undefined;
	page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
	win = new EventTarget();
	vi.stubGlobal('document', page);
	vi.stubGlobal('window', win);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('foreground recovery triggers', () => {
	test('retired backlog setup is removed and replaced without waiting for the reaper', async () => {
		let rejectBacklog!: (error: Error) => void;
		const backlog = new Promise<never>((_, reject) => {
			rejectBacklog = reject;
		});
		groups.mockReturnValue([{ id: 'group', coordinatorKey: 'bb'.repeat(32), fetchCursor: 1 }]);
		const old = { FetchManyGroupMessages: vi.fn(() => backlog) };
		client.current = old;
		await start();
		expect(old.FetchManyGroupMessages).toHaveBeenCalledTimes(1);
		const fresh = {
			FetchManyGroupMessages: vi.fn().mockResolvedValue({ messages: [] }),
			SubscribeManyGroupMessages: vi.fn(() => new Promise(() => {}))
		};
		client.current = fresh;
		rejectBacklog(new Error('Connection closed'));
		await vi.waitFor(() => expect(fresh.SubscribeManyGroupMessages).toHaveBeenCalledTimes(1));
		expect(unwatched).toHaveBeenCalledWith('group');
	});

	test('stopping a group without a watch leaves registered watches intact', async () => {
		const aborts: Array<ReturnType<typeof vi.fn>> = [];
		groups.mockReturnValue([{ id: 'group', coordinatorKey: 'bb'.repeat(32), fetchCursor: 1 }]);
		client.current = {
			FetchManyGroupMessages: vi.fn().mockResolvedValue({ messages: [] }),
			SubscribeManyGroupMessages: vi.fn(() => {
				const abort = vi.fn(() => Promise.resolve());
				aborts.push(abort);
				return {
					stream: {
						[Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) })
					},
					result: new Promise(() => {}),
					abort
				};
			})
		};
		await start();
		await vi.waitFor(() => expect(aborts).toHaveLength(1));
		const watch = await import('./chatGroupWatch.svelte');
		// Regression: an unknown groupId used to hit the clear-all overload and
		// unregister every watch while their streams kept running.
		watch.stopWatchingGroup('ghost', 'test');
		expect(unwatched).not.toHaveBeenCalled();
		watch.stopWatchingGroup('group', 'test');
		expect(unwatched).toHaveBeenCalledWith('group');
		expect(aborts[0]).toHaveBeenCalledTimes(1);
	});

	test.each(['heartbeat first', 'foreground first'])('signer suspension: %s', async (order) => {
		native.mockReturnValue(true);
		await start();
		signing.mockReturnValue(true);
		appListener.current!({ isActive: false });
		visibility('hidden');
		vi.setSystemTime(Date.now() + 120_000);
		signing.mockReturnValue(false);
		page.visibilityState = 'visible';
		if (order === 'heartbeat first') await vi.advanceTimersByTimeAsync(60_000);
		visibility('visible');
		appListener.current!({ isActive: true });
		if (order === 'foreground first') await vi.advanceTimersByTimeAsync(60_000);
		expect(rebuild).not.toHaveBeenCalled();
	});

	test('ordinary focus and a brief web tab switch do not replace clients', async () => {
		await start();
		win.dispatchEvent(new Event('focus'));
		visibility('hidden');
		await vi.advanceTimersByTimeAsync(1_000);
		visibility('visible');
		expect(rebuild).not.toHaveBeenCalled();
	});

	test('a long hide with a live heartbeat preserves healthy clients', async () => {
		await start();
		visibility('hidden');
		// Timers keep firing while hidden (desktop tab, not frozen): two heartbeats
		// pass, so the tab is provably alive and its sockets are not suspect.
		await vi.advanceTimersByTimeAsync(130_000);
		visibility('visible');
		win.dispatchEvent(new Event('focus'));
		win.dispatchEvent(new Event('pageshow'));
		expect(rebuild).not.toHaveBeenCalled();
	});

	test('heartbeat silence while hidden rebuilds once on return', async () => {
		await start();
		visibility('hidden');
		// Wall clock advanced but no timer ran: the process was suspended.
		vi.setSystemTime(Date.now() + 120_000);
		visibility('visible');
		win.dispatchEvent(new Event('focus'));
		win.dispatchEvent(new Event('pageshow'));
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	test('freeze/resume while hidden defers the reset until visible', async () => {
		await start();
		visibility('hidden');
		page.dispatchEvent(new Event('freeze'));
		page.dispatchEvent(new Event('resume'));
		expect(rebuild).not.toHaveBeenCalled();
		visibility('visible');
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	test('native signer return is not mistaken for a network interruption', async () => {
		native.mockReturnValue(true);
		await start();
		signing.mockReturnValue(true);
		appListener.current!({ isActive: false });
		visibility('hidden');
		await vi.advanceTimersByTimeAsync(11_000);
		signing.mockReturnValue(false); // approval can complete before lifecycle callbacks
		visibility('visible');
		appListener.current!({ isActive: true });
		expect(rebuild).not.toHaveBeenCalled();
		expect(setFocused).toHaveBeenLastCalledWith(true);
		appListener.current!({ isActive: false });
		await vi.advanceTimersByTimeAsync(11_000);
		appListener.current!({ isActive: true });
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	test('network return and a missed visible heartbeat replace stale clients', async () => {
		await start();
		win.dispatchEvent(new Event('online'));
		expect(rebuild).toHaveBeenCalledTimes(1);
		vi.setSystemTime(Date.now() + 120_000); // JS did not get timer turns during suspension
		await vi.advanceTimersByTimeAsync(60_000);
		expect(rebuild).toHaveBeenCalledTimes(2);
	});
});
