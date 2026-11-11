import { beforeEach, describe, expect, test, vi } from 'vitest';

const { acceptChatWelcome, goto, toastSuccess } = vi.hoisted(() => ({
	acceptChatWelcome: vi.fn(),
	goto: vi.fn(),
	toastSuccess: vi.fn()
}));

vi.mock('$app/environment', () => ({ browser: true, dev: false }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$app/paths', () => ({ resolve: () => '/chat/x' }));
vi.mock('svelte-sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { getActive: () => ({ pubkey: 'aa'.repeat(32) }) }
}));
vi.mock('$lib/services/chatAdminPolicy', () => ({ isGroupAdmin: () => false }));
vi.mock('$lib/services/coordinatorHealth.svelte', () => ({
	throwIfCoordinatorInReadBackoff: vi.fn()
}));
vi.mock('$lib/services/chatRuntime', () => ({
	requireActiveAccount: () => ({ pubkey: 'aa'.repeat(32) }),
	assertCoordinatorOperationActive: vi.fn(),
	withCoordinatorClientRetry: vi.fn()
}));
vi.mock('$lib/services/chatGroupLinks.svelte', () => ({ groupRouteId: (id: string) => id }));
vi.mock('$lib/services/chatGroups.svelte', () => ({
	acceptChatWelcome,
	createChatGroup: vi.fn(),
	deleteChatGroup: vi.fn(),
	ensureGroupsLoaded: async () => {},
	inviteChatGroupMember: vi.fn(),
	listChatGroups: () => [],
	listCoordinatorAvailableKeyPackages: vi.fn(),
	recoverPoisonedChatGroup: vi.fn(),
	removeChatGroupMember: vi.fn(),
	sendChatGroupMessage: vi.fn(),
	updateChatGroupMetadata: vi.fn()
}));
vi.mock('$lib/services/chatGroupPresence.svelte', () => ({ removeChatGroupPresence: vi.fn() }));
vi.mock('$lib/services/chatGroupPins.svelte', () => ({ removeChatGroupPin: vi.fn() }));
vi.mock('$lib/services/chatGroupWatch.svelte', () => ({
	stopWatchingGroup: vi.fn(),
	refreshWatchedGroups: vi.fn()
}));
vi.mock('$lib/services/chatGroupWatchStatus.svelte', () => ({
	getChatGroupResumePromise: () => null
}));
vi.mock('$lib/services/appUpdate.svelte', () => ({ checkForUpdateNow: vi.fn() }));
vi.mock('$lib/services/nativeShims', () => ({ isNativePlatform: () => false }));
vi.mock('$lib/services/multiDevice.svelte', () => ({
	softDeleteGroup: vi.fn(),
	isMultiDeviceActive: () => false
}));
vi.mock('$lib/services/chatKeyPackages.svelte', () => ({ ensureLastResortPublished: vi.fn() }));
vi.mock('$lib/services/lastResortConflict.svelte', () => ({ promptForeignLastResort: vi.fn() }));
vi.mock('$lib/services/chatCoordinators.svelte', () => ({
	getDefaultChatCoordinator: () => undefined
}));
vi.mock('$lib/services/chatEmojiMedia', () => ({ emojiMediaTagsForContent: () => [] }));
vi.mock('$lib/query-client', () => ({ queryClient: { fetchQuery: vi.fn() } }));
vi.mock('$lib/queries/chatQueryKeys', () => ({ chatQueryKeys: {} }));
vi.mock('$lib/queries/chatKeyPackageQueries', () => ({
	fetchCoordinatorAvailableKeyPackages: vi.fn()
}));
vi.mock('$lib/queries/chatWelcomeQueries', () => ({
	fetchCoordinatorWelcomeNotifications: vi.fn(async () => [])
}));
vi.mock('$lib/queries/chatJoinRequestQueries', () => ({
	fetchCoordinatorJoinRequests: vi.fn(async () => [])
}));

// Two Welcomes sharing one key package (a last-resort package carries invitations
// to any group): only the preview's gid may decide which one answers the request.
let welcomesForTest: unknown[] = [];
vi.mock('$lib/services/chatWelcomeNotifications.svelte', () => ({
	chatWelcomeNotificationsStore: { error: '', submittingIds: {} },
	listWelcomeNotifications: () => welcomesForTest,
	isWelcomeSubmitting: () => false,
	setWelcomeSubmitting: vi.fn(),
	clearWelcomeSubmitting: vi.fn(),
	getWelcomeNotification: () => undefined,
	markWelcomeDismissed: vi.fn()
}));

import { sentJoinRequestsStore } from '$lib/services/chatJoinRequests.svelte';
import { autoAcceptJoinRequestWelcomesAction } from '$lib/services/chatUiActions.svelte';

const COORDINATOR = 'bb'.repeat(32);

function welcome(id: string, gid: string) {
	return { id, kpRef: 'shared-kp', at: 1, coordinatorKey: COORDINATOR, preview: { gid } };
}

describe('autoAcceptJoinRequestWelcomesAction', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		acceptChatWelcome.mockResolvedValue({ id: 'requested-gid' });
		sentJoinRequestsStore.entries = [{ gid: 'requested-gid', coordinatorKey: COORDINATOR, at: 1 }];
	});

	test('accepts the Welcome that answers the request, in place, and leaves the rest', async () => {
		welcomesForTest = [
			welcome('answers-request', 'requested-gid'),
			welcome('stranger', 'other-gid')
		];

		await autoAcceptJoinRequestWelcomesAction();

		expect(acceptChatWelcome).toHaveBeenCalledTimes(1);
		expect(acceptChatWelcome).toHaveBeenCalledWith({ welcomeId: 'answers-request' });
		expect(goto).not.toHaveBeenCalled();
		expect(toastSuccess).toHaveBeenCalledTimes(1);
	});

	test('accepts nothing while no request is pending', async () => {
		sentJoinRequestsStore.entries = [];
		welcomesForTest = [welcome('answers-request', 'requested-gid')];

		await autoAcceptJoinRequestWelcomesAction();

		expect(acceptChatWelcome).not.toHaveBeenCalled();
	});
});
