import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { StoredChatGroup } from './chatGroups.svelte';

const clientStateDecoderMock = vi.fn();
const requireActiveAccountMock = vi.fn();
const createWorkingChatGroupSessionMock = vi.fn();
const buildPersistedChatGroupMock = vi.fn();
const enqueuePendingEpochOperationMock = vi.fn();
const removeMemberFromGroupMock = vi.fn();
const getCoordinatorClientMock = vi.fn();
const pruneZombieKeyPackagesMock = vi.fn().mockResolvedValue(undefined);

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
	createChatKeyPackage: vi.fn(),
	pruneZombieKeyPackages: pruneZombieKeyPackagesMock
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
			snapshots: [],
			joinEpoch: 0n
		};

		expect(isChatGroupPoisoned(poisonedGroup)).toBe(true);
	});

	test('returns true for legacy fatal MLS sync issues', async () => {
		const { isChatGroupPoisoned } = await import('./chatGroups.svelte');

		const legacyPoisonedGroup = {
			id: 'legacy-poisoned',
			status: 'active' as const,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [
				{
					cursor: 7,
					createdAt: 1,
					detail: 'Fatal MLS decryption failure: OperationError: The operation failed'
				}
			],
			snapshots: [],
			joinEpoch: 0n
		};

		expect(isChatGroupPoisoned(legacyPoisonedGroup)).toBe(true);
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
			snapshots: [],
			joinEpoch: 0n
		};

		expect(isChatGroupPoisoned(activeGroup)).toBe(false);
	});

	test('returns false for non-fatal sync issues', async () => {
		const { isChatGroupPoisoned } = await import('./chatGroups.svelte');

		const activeGroup = {
			id: 'active-with-issue',
			status: 'active' as const,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [
				{
					cursor: 3,
					createdAt: 1,
					detail: 'Cannot process message, epoch too old'
				}
			],
			snapshots: [],
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
		] as StoredChatGroup[];

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
		] as StoredChatGroup[];

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

		chatGroupsStore.groups = [poisonedGroup] as StoredChatGroup[];

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
		const { getNewestHealthySnapshot } = await import('./chatGroupSnapshots');

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
		const { getNewestHealthySnapshot } = await import('./chatGroupSnapshots');

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
				coordinatorKey: 'cc'.repeat(32),
				createdAt: 1,
				stateBase64: 'AA==',
				lastCursor: 0,
				fetchCursor: 0,
				messages: [],
				syncIssues: [],
				snapshots: [],
				joinEpoch: 0n,
				metadata: { name: 'Admins Only', adminPubkeys: ['aa'.repeat(32)] }
			}
		] as StoredChatGroup[];

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
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n,
			metadata: { name: 'demo', adminPubkeys: ['aa'.repeat(32)] }
		});

		chatGroupsStore.groups = [
			{
				id: 'demo',
				coordinatorKey: 'cc'.repeat(32),
				createdAt: 1,
				stateBase64: 'AA==',
				lastCursor: 0,
				fetchCursor: 0,
				messages: [],
				syncIssues: [],
				snapshots: [],
				joinEpoch: 0n,
				metadata: { name: 'demo', adminPubkeys: ['bb'.repeat(32)] }
			}
		] as StoredChatGroup[];

		await removeChatGroupMember({ groupId: 'demo', targetStablePubkey: 'aa'.repeat(32) });

		expect(removeMemberFromGroupMock).toHaveBeenCalled();
		expect(postGroupMessageMock).toHaveBeenCalledWith({ msg_64: 'commit' });
		expect(enqueuePendingEpochOperationMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: 'remove-member', targetStablePubkey: 'aa'.repeat(32) })
		);
	});
});

describe('snapshot persistence', () => {
	test('round-trips snapshots through storage put and get', async () => {
		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();

		const group = {
			id: 'snapshot-roundtrip',
			ownerPubkey: 'aa'.repeat(32),
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			lastCursor: 5,
			fetchCursor: 5,
			status: 'active' as const,
			stateBytes: new Uint8Array([1, 2, 3]),
			messages: [],
			syncIssues: [],
			snapshots: [
				{
					groupId: 'snapshot-roundtrip',
					status: 'healthy' as const,
					epoch: '2',
					cursor: 3,
					createdAt: 200,
					stateBytes: new Uint8Array([4, 5, 6]),
					triggerCursor: 3
				}
			]
		};

		await storage.putGroup(group);
		const loaded = await storage.getGroup('snapshot-roundtrip');

		expect(loaded).toBeDefined();
		expect(loaded!.snapshots).toBeDefined();
		expect(loaded!.snapshots!.length).toBe(1);
		expect(loaded!.snapshots![0].status).toBe('healthy');
		expect(loaded!.snapshots![0].epoch).toBe('2');
		expect(loaded!.snapshots![0].cursor).toBe(3);
		expect(loaded!.snapshots![0].triggerCursor).toBe(3);

		await storage.deleteGroup('snapshot-roundtrip');
	});

	test('returns undefined snapshots when group has no snapshots', async () => {
		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();

		const group = {
			id: 'no-snapshots',
			ownerPubkey: 'aa'.repeat(32),
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			lastCursor: 0,
			fetchCursor: 0,
			status: 'active' as const,
			stateBytes: new Uint8Array([1]),
			messages: [],
			syncIssues: []
		};

		await storage.putGroup(group);
		const loaded = await storage.getGroup('no-snapshots');

		expect(loaded).toBeDefined();
		expect(loaded!.snapshots).toBeUndefined();

		await storage.deleteGroup('no-snapshots');
	});

	test('overwrites existing snapshot record on subsequent put', async () => {
		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();

		const groupId = 'overwrite-snapshots';
		const first = {
			id: groupId,
			ownerPubkey: 'aa'.repeat(32),
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			lastCursor: 5,
			fetchCursor: 5,
			status: 'active' as const,
			stateBytes: new Uint8Array([1]),
			messages: [],
			syncIssues: [],
			snapshots: [
				{
					groupId,
					status: 'healthy' as const,
					epoch: '1',
					cursor: 0,
					createdAt: 100,
					stateBytes: new Uint8Array([1])
				}
			]
		};

		await storage.putGroup(first);
		const loaded1 = await storage.getGroup(groupId);
		expect(loaded1!.snapshots!.length).toBe(1);
		expect(loaded1!.snapshots![0].epoch).toBe('1');

		const second = {
			...first,
			fetchCursor: 10,
			snapshots: [
				{
					groupId,
					status: 'tentative' as const,
					epoch: '2',
					cursor: 10,
					createdAt: 200,
					stateBytes: new Uint8Array([2])
				}
			]
		};

		await storage.putGroup(second);
		const loaded2 = await storage.getGroup(groupId);
		expect(loaded2!.snapshots!.length).toBe(1);
		expect(loaded2!.snapshots![0].epoch).toBe('2');
		expect(loaded2!.snapshots![0].status).toBe('tentative');

		await storage.deleteGroup(groupId);
	});

	test('clears snapshot record when putting group with empty snapshots', async () => {
		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();

		const groupId = 'clear-snapshots';
		const withSnapshots = {
			id: groupId,
			ownerPubkey: 'aa'.repeat(32),
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			lastCursor: 5,
			fetchCursor: 5,
			status: 'active' as const,
			stateBytes: new Uint8Array([1]),
			messages: [],
			syncIssues: [],
			snapshots: [
				{
					groupId,
					status: 'healthy' as const,
					epoch: '1',
					cursor: 0,
					createdAt: 100,
					stateBytes: new Uint8Array([1])
				}
			]
		};

		await storage.putGroup(withSnapshots);
		const loaded1 = await storage.getGroup(groupId);
		expect(loaded1!.snapshots!.length).toBe(1);

		const withoutSnapshots = {
			...withSnapshots,
			fetchCursor: 10,
			snapshots: []
		};

		await storage.putGroup(withoutSnapshots);
		const loaded2 = await storage.getGroup(groupId);
		expect(loaded2!.snapshots).toBeUndefined();

		await storage.deleteGroup(groupId);
	});
});

describe('appendHealthySnapshot()', () => {
	test('adds a healthy snapshot to empty list', async () => {
		const { appendHealthySnapshot } = await import('./chatGroupSnapshots');

		const result = appendHealthySnapshot([], {
			groupId: 'test',
			status: 'healthy',
			epoch: '1',
			cursor: 0,
			createdAt: 100,
			stateBase64: 'AA=='
		});

		expect(result.length).toBe(1);
		expect(result[0].status).toBe('healthy');
		expect(result[0].epoch).toBe('1');
	});

	test('keeps at most 3 snapshots', async () => {
		const { appendHealthySnapshot } = await import('./chatGroupSnapshots');

		const base = [
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
				status: 'healthy' as const,
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

		const result = appendHealthySnapshot(base, {
			groupId: 'test',
			status: 'healthy',
			epoch: '4',
			cursor: 15,
			createdAt: 400,
			stateBase64: 'DD=='
		});

		expect(result.length).toBe(3);
		expect(result[0].epoch).toBe('2');
		expect(result[1].epoch).toBe('3');
		expect(result[2].epoch).toBe('4');
	});

	test('drops tentative snapshots when appending healthy', async () => {
		const { appendHealthySnapshot } = await import('./chatGroupSnapshots');

		const base = [
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
			}
		];

		const result = appendHealthySnapshot(base, {
			groupId: 'test',
			status: 'healthy',
			epoch: '3',
			cursor: 10,
			createdAt: 300,
			stateBase64: 'CC=='
		});

		expect(result.length).toBe(2);
		expect(result[0].status).toBe('healthy');
		expect(result[1].status).toBe('healthy');
	});
});

describe('loadGroups snapshot baseline', () => {
	test('creates baseline healthy snapshot for legacy group with no snapshots', async () => {
		vi.doMock('$lib/services/chatRuntime', () => ({
			getCoordinatorClient: getCoordinatorClientMock,
			requireActiveAccount: requireActiveAccountMock,
			withCoordinatorClient: withCoordinatorClientMock
		}));

		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();

		const ownerPubkey = 'bb'.repeat(32);
		const groupId = 'legacy-baseline';

		// Seed storage with a group that has no snapshots and a decodable state
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: { groupId: new Uint8Array([100]), epoch: 2n },
				ratchetTree: [],
				groupActiveState: { kind: 'active' }
			}
		]);

		await storage.putGroup({
			id: groupId,
			ownerPubkey,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			lastCursor: 0,
			fetchCursor: 5,
			status: 'active',
			stateBytes: new Uint8Array([1]),
			messages: [],
			syncIssues: []
			// no snapshots
		});

		// Load groups for this owner
		const { reloadChatGroupsForOwner, chatGroupsStore } = await import('./chatGroups.svelte');
		await reloadChatGroupsForOwner(ownerPubkey);

		const loaded = chatGroupsStore.groups.find((g) => g.id === groupId);
		expect(loaded).toBeDefined();
		expect(loaded!.snapshots.length).toBe(1);
		expect(loaded!.snapshots[0].status).toBe('healthy');
		expect(loaded!.snapshots[0].cursor).toBe(5); // fetchCursor
		expect(loaded!.snapshots[0].epoch).toBe('2');

		// Cleanup
		await storage.deleteGroup(groupId);
		clientStateDecoderMock.mockReset();
	});

	test('skips baseline for poisoned group', async () => {
		vi.doMock('$lib/services/chatRuntime', () => ({
			getCoordinatorClient: getCoordinatorClientMock,
			requireActiveAccount: requireActiveAccountMock,
			withCoordinatorClient: withCoordinatorClientMock
		}));

		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();

		const ownerPubkey = 'bb'.repeat(32);
		const groupId = 'poisoned-no-baseline';

		await storage.putGroup({
			id: groupId,
			ownerPubkey,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			lastCursor: 0,
			fetchCursor: 5,
			status: 'poisoned',
			stateBytes: new Uint8Array([1]),
			messages: [],
			syncIssues: []
			// no snapshots
		});

		const { reloadChatGroupsForOwner, chatGroupsStore } = await import('./chatGroups.svelte');
		await reloadChatGroupsForOwner(ownerPubkey);

		const loaded = chatGroupsStore.groups.find((g) => g.id === groupId);
		expect(loaded).toBeDefined();
		expect(loaded!.snapshots.length).toBe(0);

		await storage.deleteGroup(groupId);
	});
});

describe('deleteChatGroupsForCoordinator()', () => {
	test('removes only groups for the given coordinator', async () => {
		const { chatGroupsStore, deleteChatGroupsForCoordinator } = await import('./chatGroups.svelte');

		const coordinatorA = 'aa'.repeat(32);
		const coordinatorB = 'bb'.repeat(32);
		chatGroupsStore.groups = [
			{ id: 'a1', coordinatorKey: coordinatorA } as unknown as StoredChatGroup,
			{ id: 'a2', coordinatorKey: coordinatorA } as unknown as StoredChatGroup,
			{ id: 'b1', coordinatorKey: coordinatorB } as unknown as StoredChatGroup
		];

		await deleteChatGroupsForCoordinator(coordinatorA);

		expect(chatGroupsStore.groups.map((g) => g.id)).toEqual(['b1']);
	});
});

describe('pruneConsumedKeyPackagesForActiveGroups()', () => {
	beforeEach(() => {
		pruneZombieKeyPackagesMock.mockReset();
		pruneZombieKeyPackagesMock.mockResolvedValue(undefined);
	});

	test('delegates only the consumed refs of existing groups', async () => {
		const { chatGroupsStore, pruneConsumedKeyPackagesForActiveGroups } =
			await import('./chatGroups.svelte');

		chatGroupsStore.groups = [
			{ id: 'g1', joinedWithKeyPackageRef: 'kp-a' } as StoredChatGroup,
			{ id: 'g2', joinedWithKeyPackageRef: undefined } as StoredChatGroup,
			{ id: 'g3', joinedWithKeyPackageRef: 'kp-b' } as StoredChatGroup
		];

		await pruneConsumedKeyPackagesForActiveGroups();

		expect(pruneZombieKeyPackagesMock).toHaveBeenCalledTimes(1);
		expect(pruneZombieKeyPackagesMock).toHaveBeenCalledWith(
			expect.arrayContaining(['kp-a', 'kp-b'])
		);
		const arg = pruneZombieKeyPackagesMock.mock.calls[0][0] as string[];
		expect(arg).toHaveLength(2);
		expect(arg).not.toContain(undefined);
	});
});
