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

describe('inviteChatGroupMember()', () => {
	beforeEach(() => {
		clientStateDecoderMock.mockReset();
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: { groupId: new Uint8Array([100]) },
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
		const postGroupMessageMock = vi.fn().mockResolvedValue(undefined);
		getCoordinatorClientMock.mockReturnValue({ PostGroupMessage: postGroupMessageMock });
		removeMemberFromGroupMock.mockResolvedValue({
			newState: { groupContext: { groupId: new Uint8Array([100]) } },
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
