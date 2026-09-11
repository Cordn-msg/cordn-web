import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryObserver } from '@tanstack/svelte-query';

const { getActive, welcomeRead, joinRead } = vi.hoisted(() => ({
	getActive: vi.fn(),
	welcomeRead: vi.fn(),
	joinRead: vi.fn()
}));
vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$lib/services/accountManager.svelte', () => ({ manager: { getActive } }));
vi.mock('$lib/services/chatCoordinators.svelte', () => ({
	getChatCoordinator: () => ({ relays: ['wss://offline.invalid'] }),
	listKnownCoordinatorKeys: () => ['bb'.repeat(32)],
	getCoordinatorLabel: (key: string) => key
}));
vi.mock('$lib/services/chatGroups.svelte', () => ({
	ensureGroupsLoaded: async () => {},
	listChatGroups: () => [{ id: 'group', coordinatorKey: 'bb'.repeat(32) }],
	listChatGroupMembers: () => [],
	inviteChatGroupMember: vi.fn(),
	removeChatGroupMember: vi.fn()
}));
vi.mock('$lib/services/chatAdminPolicy', () => ({ isGroupAdmin: () => true }));
vi.mock('$lib/services/chatKeyPackages.svelte', () => ({
	getChatKeyPackage: () => undefined,
	decodeStoredKeyPackage: vi.fn()
}));
vi.mock('$lib/services/chatMlsUtils', () => ({ previewGroupMetadataFromWelcome: vi.fn() }));
vi.mock('$lib/services/relay-pool', () => ({ defaultRelays: ['wss://offline.invalid'] }));
vi.mock('$lib/query-client', async () => {
	const { QueryClient } = await import('@tanstack/svelte-query');
	return {
		queryClient: new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Infinity } }
		})
	};
});
vi.mock('$lib/services/coordinatorClient', () => {
	class StubClient {
		private lifecycle = new AbortController();
		signal = this.lifecycle.signal;
		relays = ['wss://offline.invalid'];
		get isClosed() {
			return this.signal.aborted;
		}
		FetchPendingWelcomes = welcomeRead;
		FetchManyPendingJoinRequests = joinRead;
		async disconnect() {
			this.lifecycle.abort(new Error('Connection closed'));
		}
	}
	return { cordnClient: StubClient };
});

import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from './chatQueryKeys';
import { welcomeNotificationsQueryOptions } from './chatWelcomeQueries';
import { joinRequestsQueryOptions } from './chatJoinRequestQueries';
import { chatWelcomeNotificationsStore } from '$lib/services/chatWelcomeNotifications.svelte';
import { chatJoinRequestsStore } from '$lib/services/chatJoinRequests.svelte';
import {
	markCoordinatorDegraded,
	coordinatorHealthStore
} from '$lib/services/coordinatorHealth.svelte';
import {
	disconnectCoordinatorClients,
	getCoordinatorClient,
	rebuildAllCoordinatorClients
} from '$lib/services/chatRuntime';

const ACCOUNT = { id: 'query-account', pubkey: 'aa'.repeat(32), signer: {} } as never;
const OWNER = 'aa'.repeat(32);
const COORDINATOR = 'bb'.repeat(32);
const oldWelcome = {
	id: 'old',
	coordinatorKey: COORDINATOR,
	kpRef: 'old',
	at: 1,
	welcomeBase64: 'old',
	fetchedAt: 1
};
const newWelcome = { kp_ref: 'new', at: 2, welcome_64: 'new' };
const unsubscribes: (() => void)[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	getActive.mockReturnValue(ACCOUNT);
	welcomeRead.mockResolvedValue({ welcomes: [] });
	joinRead.mockResolvedValue({ requests: [] });
	chatWelcomeNotificationsStore.entries = [{ ...oldWelcome }];
	chatWelcomeNotificationsStore.lastFetchedAtByCoordinator = {};
	chatJoinRequestsStore.entries = [];
	coordinatorHealthStore.byCoordinator.clear();
	vi.stubGlobal('localStorage', {
		getItem: () => null,
		setItem: vi.fn(),
		removeItem: vi.fn()
	});
});

afterEach(async () => {
	for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
	queryClient.clear();
	await disconnectCoordinatorClients(ACCOUNT);
	vi.unstubAllGlobals();
});

describe('coordinator query recovery', () => {
	test('a failed welcome refresh stays an error and retains local rows', async () => {
		welcomeRead.mockRejectedValue(new Error('network failure'));
		await expect(
			queryClient.fetchQuery(welcomeNotificationsQueryOptions(OWNER, COORDINATOR))
		).rejects.toThrow('network failure');
		expect(
			queryClient.getQueryState(chatQueryKeys.welcomeNotifications(OWNER, COORDINATOR))?.status
		).toBe('error');
		expect(chatWelcomeNotificationsStore.entries).toEqual([oldWelcome]);
	});

	test('read backoff is not cached as a successful empty welcome fetch', async () => {
		markCoordinatorDegraded(COORDINATOR, 'offline');
		await expect(
			queryClient.fetchQuery(welcomeNotificationsQueryOptions(OWNER, COORDINATOR))
		).rejects.toThrow('recent failure');
		expect(welcomeRead).not.toHaveBeenCalled();
		expect(chatWelcomeNotificationsStore.entries).toEqual([oldWelcome]);
	});

	test('join-request RPC failures propagate without wiping pending rows', async () => {
		const entry = {
			id: 'join',
			coordinatorKey: COORDINATOR,
			groupId: 'group',
			requesterStablePubkey: 'cc'.repeat(32),
			kpRef: 'kp',
			at: 1,
			fetchedAt: 1
		};
		chatJoinRequestsStore.entries = [entry];
		joinRead.mockRejectedValue(new Error('network failure'));
		await expect(
			queryClient.fetchQuery(joinRequestsQueryOptions(OWNER, COORDINATOR))
		).rejects.toThrow('network failure');
		expect(chatJoinRequestsStore.entries).toEqual([entry]);
	});

	test('cancelled read responses cannot mutate the welcome store', async () => {
		const pending = deferred<{ welcomes: (typeof newWelcome)[] }>();
		welcomeRead.mockReturnValueOnce(pending.promise);
		const fetching = queryClient.fetchQuery(welcomeNotificationsQueryOptions(OWNER, COORDINATOR));
		const cancelled = expect(fetching).rejects.toBeDefined();
		await vi.waitFor(() => expect(welcomeRead).toHaveBeenCalledTimes(1));
		await queryClient.cancelQueries({ queryKey: chatQueryKeys.coordinators(OWNER) });
		pending.resolve({ welcomes: [newWelcome] });
		await cancelled;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(chatWelcomeNotificationsStore.entries).toEqual([oldWelcome]);
	});

	test('foreground refetch does not wait for retired work', async () => {
		const pending = deferred<{ welcomes: (typeof newWelcome)[] }>();
		welcomeRead.mockReturnValueOnce(pending.promise).mockResolvedValue({ welcomes: [newWelcome] });
		const observer = new QueryObserver(
			queryClient,
			welcomeNotificationsQueryOptions(OWNER, COORDINATOR)
		);
		unsubscribes.push(observer.subscribe(() => {}));
		await vi.waitFor(() => expect(welcomeRead).toHaveBeenCalledTimes(1));
		const old = getCoordinatorClient(ACCOUNT, COORDINATOR);
		rebuildAllCoordinatorClients(ACCOUNT);
		await vi.waitFor(() => expect(welcomeRead).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
		expect(getCoordinatorClient(ACCOUNT, COORDINATOR)).not.toBe(old);
		pending.resolve({ welcomes: [] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(chatWelcomeNotificationsStore.entries.map((entry) => entry.kpRef)).toEqual(['new']);
	});

	test('responses from the old account do not merge into the new account store', async () => {
		const pending = deferred<{ welcomes: (typeof newWelcome)[] }>();
		welcomeRead.mockReturnValueOnce(pending.promise);
		const fetching = queryClient.fetchQuery(welcomeNotificationsQueryOptions(OWNER, COORDINATOR));
		const failed = expect(fetching).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(welcomeRead).toHaveBeenCalledTimes(1));
		getActive.mockReturnValue({ id: 'other', pubkey: 'dd'.repeat(32) });
		chatWelcomeNotificationsStore.entries = [];
		pending.resolve({ welcomes: [newWelcome] });
		await failed;
		expect(chatWelcomeNotificationsStore.entries).toEqual([]);
	});
});
