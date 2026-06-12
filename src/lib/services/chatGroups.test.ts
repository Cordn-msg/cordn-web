import { beforeEach, describe, expect, test, vi } from 'vitest';

const clientStateDecoderMock = vi.fn();
const requireActiveAccountMock = vi.fn();
const createWorkingChatGroupSessionMock = vi.fn();
const buildPersistedChatGroupMock = vi.fn();
const enqueuePendingEpochOperationMock = vi.fn();
const removeMemberFromGroupMock = vi.fn();
const getCoordinatorClientMock = vi.fn();

vi.mock('ts-mls', async () => {
	const actual = await vi.importActual<typeof import('ts-mls')>('ts-mls');
	return {
		...actual,
		clientStateDecoder: clientStateDecoderMock
	};
});

vi.mock('$app/environment', () => ({ browser: false }));

const withCoordinatorClientMock = vi.fn(
	<T>(account: unknown, coordinatorKey: string, operation: (client: T) => Promise<unknown>) =>
		operation(getCoordinatorClientMock(account, coordinatorKey) as T)
);

vi.mock('$lib/services/chatRuntime', () => ({
	getCoordinatorClient: getCoordinatorClientMock,
	requireActiveAccount: requireActiveAccountMock,
	withCoordinatorClient: withCoordinatorClientMock
}));

vi.mock('$lib/services/chatCoordinators.svelte', () => ({
	markCoordinatorUsed: vi.fn()
}));

vi.mock('$lib/services/chatKeyPackages.svelte', () => ({
	createChatKeyPackage: vi.fn()
}));

vi.mock('$lib/services/chatGroupLifecycle.svelte', () => ({
	acceptWelcomeToGroup: vi.fn(),
	buildStoredChatGroup: vi.fn(),
	createInitialGroupState: vi.fn(),
	createMemberArtifacts: vi.fn()
}));

vi.mock('$lib/services/chatWelcomeNotifications.svelte', () => ({
	getWelcomeNotification: vi.fn(),
	markWelcomeAccepted: vi.fn()
}));

vi.mock('$lib/services/chatGroupMessages.svelte', () => ({
	createApplicationMessageBase64: vi.fn(),
	createSystemMessagesFromStateChange: vi.fn(() => []),
	createUnsignedCordnMessageEvent: vi.fn(),
	encodeAuthenticatedSender: vi.fn()
}));

vi.mock('$lib/services/chatGroupProtocol', () => ({
	createGroupPendingEpochStore: vi.fn(() => new Map()),
	enqueuePendingEpochOperation: enqueuePendingEpochOperationMock
}));

vi.mock('$lib/services/chatGroupSessions.svelte', () => ({
	buildPersistedChatGroup: buildPersistedChatGroupMock,
	createWorkingChatGroupSession: createWorkingChatGroupSessionMock,
	syncChatGroupMessages: vi.fn()
}));

vi.mock('$lib/services/chatMlsUtils', () => ({
	addMemberToGroup: vi.fn(),
	encodeWelcomeBase64: vi.fn(),
	findMemberLeafIndexByStablePubkey: vi.fn(() => 4),
	getCordnGroupMetadataExtension: vi.fn(),
	parseConsumedPublishedKeyPackage: vi.fn(),
	removeMemberFromGroup: removeMemberFromGroupMock,
	SelfRemovalNotSupportedError: class SelfRemovalNotSupportedError extends Error {
		constructor(groupId: string) {
			super(`Removing the active member is not supported in group: ${groupId}`);
			this.name = 'SelfRemovalNotSupportedError';
		}
	}
}));

describe('isChatGroupPoisoned()', () => {
	test('returns true when group status is poisoned', async () => {
		const { isChatGroupPoisoned } = await import('./chatGroups.svelte');

		const poisonedGroup = {
			id: 'poisoned',
			status: 'poisoned' as const,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			joinEpoch: 0n
		};

		expect(isChatGroupPoisoned(poisonedGroup)).toBe(true);
	});

	test('returns false when group status is active', async () => {
		const { isChatGroupPoisoned } = await import('./chatGroups.svelte');

		const activeGroup = {
			id: 'active',
			status: 'active' as const,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			joinEpoch: 0n
		};

		expect(isChatGroupPoisoned(activeGroup)).toBe(false);
	});

	test('returns false when group is undefined', async () => {
		const { isChatGroupPoisoned } = await import('./chatGroups.svelte');
		expect(isChatGroupPoisoned(undefined)).toBe(false);
	});
});

describe('recoverPoisonedChatGroup()', () => {
	beforeEach(() => {
		clientStateDecoderMock.mockReset();
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: { groupId: new Uint8Array([100]), epoch: 2n },
				ratchetTree: [],
				groupActiveState: { kind: 'active' }
			}
		]);
		requireActiveAccountMock.mockReset();
		requireActiveAccountMock.mockReturnValue({ pubkey: 'bb'.repeat(32) });
		createWorkingChatGroupSessionMock.mockReset();
		buildPersistedChatGroupMock.mockReset();
		getCoordinatorClientMock.mockReset();
	});

	test('returns true when group is not poisoned', async () => {
		const { chatGroupsStore, recoverPoisonedChatGroup } = await import('./chatGroups.svelte');

		chatGroupsStore.groups = [
			{
				id: 'healthy',
				status: 'active',
				coordinatorKey: 'cc'.repeat(32),
				createdAt: 1,
				stateBase64: 'AA==',
				lastCursor: 0,
				fetchCursor: 0,
				messages: [],
				syncIssues: [],
				snapshots: [],
				joinEpoch: 0n
			}
		] as never;

		const result = await recoverPoisonedChatGroup('healthy');
		expect(result).toBe(true);
	});

	test('returns false when no healthy snapshot available', async () => {
		const { chatGroupsStore, recoverPoisonedChatGroup } = await import('./chatGroups.svelte');

		chatGroupsStore.groups = [
			{
				id: 'poisoned',
				status: 'poisoned',
				coordinatorKey: 'cc'.repeat(32),
				createdAt: 1,
				stateBase64: 'AA==',
				lastCursor: 0,
				fetchCursor: 0,
				messages: [],
				syncIssues: [],
				snapshots: [],
				joinEpoch: 0n
			}
		] as never;

		const result = await recoverPoisonedChatGroup('poisoned');
		expect(result).toBe(false);
	});

	test('keeps group poisoned when recovery fails', async () => {
		const { chatGroupsStore, recoverPoisonedChatGroup } = await import('./chatGroups.svelte');

		const poisonedGroup = {
			id: 'poisoned',
			status: 'poisoned' as const,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			snapshots: [
				{
					groupId: 'poisoned',
					status: 'healthy' as const,
					epoch: '1',
					cursor: 0,
					createdAt: 1,
					stateBase64: 'AA=='
				}
			],
			poisonedAtCursor: 5,
			joinEpoch: 0n
		};

		chatGroupsStore.groups = [poisonedGroup] as never;

		// Mock fetch to throw an error
		const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
		getCoordinatorClientMock.mockReturnValue({ FetchGroupMessages: fetchMock });

		const result = await recoverPoisonedChatGroup('poisoned');
		expect(result).toBe(false);

		// Verify group is still poisoned after failed recovery
		const groupAfter = chatGroupsStore.groups.find((g) => g.id === 'poisoned');
		expect(groupAfter?.status).toBe('poisoned');
	});
});

describe('getNewestHealthySnapshot()', () => {
	test('returns the newest healthy snapshot by createdAt', async () => {
		const { getNewestHealthySnapshot } = await import('./chatGroups.svelte');

		const snapshots = [
			{
				groupId: 'test',
				status: 'healthy' as const,
				epoch: '1',
				cursor: 0,
				createdAt: 100,
				stateBase64: 'AA=='
			},
			{
				groupId: 'test',
				status: 'tentative' as const,
				epoch: '2',
				cursor: 5,
				createdAt: 200,
				stateBase64: 'BB=='
			},
			{
				groupId: 'test',
				status: 'healthy' as const,
				epoch: '3',
				cursor: 10,
				createdAt: 300,
				stateBase64: 'CC=='
			}
		];

		const result = getNewestHealthySnapshot(snapshots);
		expect(result?.epoch).toBe('3');
		expect(result?.status).toBe('healthy');
	});

	test('returns undefined when no healthy snapshots exist', async () => {
		const { getNewestHealthySnapshot } = await import('./chatGroups.svelte');

		const snapshots = [
			{
				groupId: 'test',
				status: 'tentative' as const,
				epoch: '1',
				cursor: 0,
				createdAt: 100,
				stateBase64: 'AA=='
			}
		];

		const result = getNewestHealthySnapshot(snapshots);
		expect(result).toBeUndefined();
	});
});

describe('inviteChatGroupMember()', () => {
	beforeEach(() => {
		clientStateDecoderMock.mockReset();
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: { groupId: new Uint8Array([100]), epoch: 2n },
				ratchetTree: [],
				groupActiveState: { kind: 'active' }
			}
		]);
		requireActiveAccountMock.mockReset();
		requireActiveAccountMock.mockReturnValue({ pubkey: 'bb'.repeat(32) });
		createWorkingChatGroupSessionMock.mockReset();
		buildPersistedChatGroupMock.mockReset();
		enqueuePendingEpochOperationMock.mockReset();
		removeMemberFromGroupMock.mockReset();
		getCoordinatorClientMock.mockReset();
	});

	test('rejects non-admin outbound add-member attempts when admins are configured', async () => {
		const { chatGroupsStore, inviteChatGroupMember } = await import('./chatGroups.svelte');

		chatGroupsStore.groups = [
			{
				id: 'demo',
				alias: 'demo',
				coordinatorKey: 'cc'.repeat(32),
				createdAt: 1,
				stateBase64: 'AA==',
				lastCursor: 0,
				fetchCursor: 0,
				messages: [],
				syncIssues: [],
				metadata: { name: 'Admins Only', adminPubkeys: ['aa'.repeat(32)] }
			}
		] as never;

		await expect(
			inviteChatGroupMember({ groupId: 'demo', identifier: 'carol' })
		).rejects.toMatchObject({
			name: 'UnauthorizedGroupAdminActionError'
		});
	});

	test('removes a member when the current user is admin', async () => {
		const { chatGroupsStore, removeChatGroupMember } = await import('./chatGroups.svelte');
		const postGroupMessageMock = vi.fn().mockResolvedValue({ cursor: 5, at: 1000 });
		getCoordinatorClientMock.mockReturnValue({ PostGroupMessage: postGroupMessageMock });
		removeMemberFromGroupMock.mockResolvedValue({
			newState: { groupContext: { groupId: new Uint8Array([100]), epoch: 2n } },
			commitMessageBase64: 'commit'
		});
		createWorkingChatGroupSessionMock.mockReturnValue({ metadata: { name: 'demo' } });
		buildPersistedChatGroupMock.mockReturnValue({
			id: 'demo',
			alias: 'demo',
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			metadata: { name: 'demo', adminPubkeys: ['aa'.repeat(32)] }
		});

		chatGroupsStore.groups = [
			{
				id: 'demo',
				alias: 'demo',
				coordinatorKey: 'cc'.repeat(32),
				createdAt: 1,
				stateBase64: 'AA==',
				lastCursor: 0,
				fetchCursor: 0,
				messages: [],
				syncIssues: [],
				metadata: { name: 'demo', adminPubkeys: ['bb'.repeat(32)] }
			}
		] as never;

		await removeChatGroupMember({ groupId: 'demo', targetStablePubkey: 'aa'.repeat(32) });

		expect(removeMemberFromGroupMock).toHaveBeenCalled();
		expect(postGroupMessageMock).toHaveBeenCalledWith({ msg_64: 'commit' });
		expect(enqueuePendingEpochOperationMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: 'remove-member', targetStablePubkey: 'aa'.repeat(32) })
		);
	});
});
