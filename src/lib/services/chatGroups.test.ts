import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StoredChatGroup } from './chatGroups.svelte';
import type { StoredChatMessage } from './chatGroupMessages.svelte';

const clientStateDecoderMock = vi.fn();
const encodeMock = vi.fn(() => new Uint8Array([1]));
const requireActiveAccountMock = vi.fn();
const createWorkingChatGroupSessionMock = vi.fn();
const buildPersistedChatGroupMock = vi.fn();
const enqueuePendingEpochOperationMock = vi.fn();
const removeMemberFromGroupMock = vi.fn();
const getCoordinatorClientMock = vi.fn();
const pruneZombieKeyPackagesMock = vi.fn().mockResolvedValue(undefined);
const createSelfUpdateCommitMock = vi.fn();
const reconcileTipForOutboundMock = vi.fn();
const unrecoveredDropHorizonMock = vi
	.fn<(group: unknown) => number | undefined>()
	.mockReturnValue(undefined);
const ingestChatGroupMessagesMock = vi.fn();
const markDropIssuesRecoveredMock = vi
	.fn<
		(issues: Array<Record<string, unknown>>, fromCursor?: number) => Array<Record<string, unknown>>
	>()
	.mockImplementation((issues) => issues.map((issue) => ({ ...issue, recovered: true })));

vi.mock('ts-mls', async () => {
	const actual = await vi.importActual<typeof import('ts-mls')>('ts-mls');
	return {
		...actual,
		clientStateDecoder: clientStateDecoderMock,
		encode: encodeMock,
		clientStateEncoder: {}
	};
});

beforeEach(async () => {
	// The decode memo in chatGroups.svelte is content-keyed; these tests
	// re-program the decoder mock per case while reusing dummy state bytes, so
	// the memo must be reset between cases.
	const { clearDecodedStateCacheForTests } = await import('./chatGroups.svelte');
	clearDecodedStateCacheForTests();
});

vi.mock('$app/environment', () => ({ browser: false }));

const withCoordinatorClientMock = vi.fn(
	<T>(account: unknown, coordinatorKey: string, operation: (client: T) => Promise<unknown>) =>
		operation(getCoordinatorClientMock(account, coordinatorKey) as T)
);

vi.mock('$lib/services/chatRuntime', () => ({
	assertCoordinatorOperationActive: vi.fn(),
	getCoordinatorClient: getCoordinatorClientMock,
	requireActiveAccount: requireActiveAccountMock,
	withCoordinatorClient: withCoordinatorClientMock,
	withCoordinatorClientRetry: withCoordinatorClientMock
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
	createMemberArtifacts: vi.fn(),
	getProtocolGroupId: vi.fn().mockReturnValue('gid')
}));

vi.mock('$lib/services/chatWelcomeNotifications.svelte', () => ({
	getWelcomeNotification: vi.fn(),
	markWelcomeAccepted: vi.fn()
}));

vi.mock('$lib/services/chatGroupMessages.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/services/chatGroupMessages.svelte')>()),
	createApplicationMessageBase64: vi.fn(),
	createSystemMessagesFromStateChange: vi.fn(() => []),
	createUnsignedCordnMessageEvent: vi.fn(),
	encodeAuthenticatedSender: vi.fn(),
	buildInboundSystemMessage: vi.fn(() => ({ id: 'sys', content: '{}' })),
	noteFormerPayloadKey: vi.fn(async (held: Record<string, string> | undefined) => held ?? {}),
	ingestChatGroupMessages: ingestChatGroupMessagesMock,
	probeSealedMessage: vi.fn(),
	staleGenerationLeafIndex: vi.fn(() => undefined),
	unrecoveredDropHorizon: (group: unknown) => unrecoveredDropHorizonMock(group),
	markDropIssuesRecovered: (issues: Array<Record<string, unknown>>, fromCursor?: number) =>
		markDropIssuesRecoveredMock(issues, fromCursor)
}));

vi.mock('$lib/services/chatGroupPayloadCrypto', () => ({
	encryptGroupPayloadBase64: vi.fn().mockResolvedValue({ encryptedBase64: 'sealed' }),
	decryptGroupPayloadBase64: vi.fn()
}));

vi.mock('$lib/services/chatGroupProtocol', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/chatGroupProtocol')>();
	return {
		...actual,
		createGroupPendingEpochStore: vi.fn(() => new Map()),
		enqueuePendingEpochOperation: enqueuePendingEpochOperationMock
	};
});

// The §10.1 repair discipline gate lives in `reconcileTipForOutbound`'s
// result: mock ONLY it, keep the rest of the module real.
vi.mock('$lib/services/multiDevice.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/multiDevice.svelte')>();
	return {
		...actual,
		reconcileTipForOutbound: reconcileTipForOutboundMock
	};
});

vi.mock('$lib/services/chatGroupSessions.svelte', () => ({
	buildPersistedChatGroup: buildPersistedChatGroupMock,
	createWorkingChatGroupSession: createWorkingChatGroupSessionMock,
	syncChatGroupMessages: vi.fn()
}));

vi.mock('$lib/services/chatMlsUtils', async (importOriginal) => ({
	// The real cipher suite: `withLegacyEmojiMediaKey` derives a media key.
	...(await importOriginal<typeof import('$lib/services/chatMlsUtils')>()),
	addMembersToGroup: vi.fn(),
	createSelfUpdateCommit: createSelfUpdateCommitMock,
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

// Warm the heavy module graph at file scope: vi.mock is hoisted above this,
// so mocks apply, and the first in-test `await import()` no longer pays the
// transform+eval cost against its 5s timeout (the parallel-load flake).
await import('./chatGroups.svelte');

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
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 2n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
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
		getCoordinatorClientMock.mockReturnValue({ FetchManyGroupMessages: fetchMock });

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

	test('adoption retains the old catch-up state and adds the new recovery baseline', async () => {
		const { appendHealthySnapshot, getNewestHealthySnapshot } =
			await import('./chatGroupSnapshots');
		const old = {
			groupId: 'test',
			status: 'healthy' as const,
			epoch: '9',
			cursor: 0,
			createdAt: 100,
			stateBase64: 'AA=='
		};
		const adopted = { ...old, epoch: '15', cursor: 457, createdAt: 200, stateBase64: 'BB==' };

		const snapshots = appendHealthySnapshot([old], adopted);

		expect(snapshots).toEqual([old, adopted]);
		expect(getNewestHealthySnapshot(snapshots)).toEqual(adopted);
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
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 2n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
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
			inviteChatGroupMember({ groupId: 'demo', identifier: 'carol', expectedStablePubkey: 'carol' })
		).rejects.toMatchObject({
			name: 'UnauthorizedGroupAdminActionError'
		});
	});

	test('removes a member when the current user is admin', async () => {
		const { chatGroupsStore, removeChatGroupMember } = await import('./chatGroups.svelte');
		const postGroupMessageMock = vi.fn().mockResolvedValue({ cursor: 5, at: 1000 });
		getCoordinatorClientMock.mockReturnValue({ PostGroupMessage: postGroupMessageMock });
		removeMemberFromGroupMock.mockResolvedValue({
			newState: {
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 2n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				}
			},
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
		expect(postGroupMessageMock).toHaveBeenCalledWith({
			msg_64: 'sealed',
			gid: 'gid'
		});
		expect(enqueuePendingEpochOperationMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: 'remove-member', targetStablePubkey: 'aa'.repeat(32) })
		);
	});
});

describe('inviteChatGroupMembers()', () => {
	const carolPk = 'cc'.repeat(32);
	const myPk = 'bb'.repeat(32);

	function demoGroup(overrides: Partial<StoredChatGroup> = {}): StoredChatGroup {
		return {
			id: 'demo',
			coordinatorKey: 'ee'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n,
			metadata: { name: 'demo' },
			...overrides
		} as StoredChatGroup;
	}

	beforeEach(() => {
		clientStateDecoderMock.mockReset();
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 2n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
				ratchetTree: [],
				groupActiveState: { kind: 'active' }
			}
		]);
		requireActiveAccountMock.mockReset();
		requireActiveAccountMock.mockReturnValue({ pubkey: myPk });
		createWorkingChatGroupSessionMock.mockReset();
		buildPersistedChatGroupMock.mockReset();
		enqueuePendingEpochOperationMock.mockReset();
		getCoordinatorClientMock.mockReset();
	});

	test('refuses a consumed key package for another identity (fork-MR scenario K)', async () => {
		const { chatGroupsStore, inviteChatGroupMembers } = await import('./chatGroups.svelte');
		const consumeKeyPackage = vi.fn().mockResolvedValue({
			keyPackage: { pk: carolPk, kp_ref: 'ref-1', event: {} }
		});
		const fetchManyGroupMessages = vi.fn();
		const listAvailableKeyPackages = vi.fn();
		getCoordinatorClientMock.mockReturnValue({
			ConsumeKeyPackage: consumeKeyPackage,
			FetchManyGroupMessages: fetchManyGroupMessages,
			ListAvailableKeyPackages: listAvailableKeyPackages
		});
		chatGroupsStore.groups = [demoGroup()];

		// Consumed package is carol's, but the slot's expected owner is alice →
		// refused, strictly.
		const result = await inviteChatGroupMembers({
			groupId: 'demo',
			targets: [{ identifier: 'ref-1', expectedStablePubkey: 'aa'.repeat(32) }]
		});

		expect(result.failures).toEqual([
			{
				identifier: 'ref-1',
				error:
					'The coordinator returned a key package for a different identity. Refresh their packages and try again.'
			}
		]);
		// Fresh group: nothing to catch up, and the slot's owner comes from the
		// caller — the invite must not read the coordinator's listing at all.
		expect(fetchManyGroupMessages).not.toHaveBeenCalled();
		expect(listAvailableKeyPackages).not.toHaveBeenCalled();
	});

	test('consumes key packages in bounded batches', async () => {
		const { chatGroupsStore, inviteChatGroupMembers } = await import('./chatGroups.svelte');
		let inFlight = 0;
		let peak = 0;
		const consumeKeyPackage = vi.fn(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 0));
			inFlight -= 1;
			// A package for another identity: every target fails, so the batch returns
			// without committing — this test only measures how consumption is paced.
			return { keyPackage: { pk: carolPk, kp_ref: 'ref-1', event: {} } };
		});
		getCoordinatorClientMock.mockReturnValue({ ConsumeKeyPackage: consumeKeyPackage });
		chatGroupsStore.groups = [demoGroup()];

		const targets = Array.from({ length: 20 }, (_, index) => ({
			identifier: `ref-${index}`,
			expectedStablePubkey: String(index).padStart(2, '0').repeat(32)
		}));
		const result = await inviteChatGroupMembers({ groupId: 'demo', targets });

		expect(consumeKeyPackage).toHaveBeenCalledTimes(20);
		expect(result.failures).toHaveLength(20);
		expect(peak).toBeLessThanOrEqual(8);
	});

	test('still catches up established groups before inviting', async () => {
		const { chatGroupsStore, inviteChatGroupMembers } = await import('./chatGroups.svelte');
		const consumeKeyPackage = vi.fn().mockResolvedValue({
			keyPackage: { pk: carolPk, kp_ref: 'ref-1', event: {} }
		});
		const fetchManyGroupMessages = vi.fn().mockResolvedValue({ messages: [] });
		getCoordinatorClientMock.mockReturnValue({
			ConsumeKeyPackage: consumeKeyPackage,
			FetchManyGroupMessages: fetchManyGroupMessages
		});
		chatGroupsStore.groups = [
			demoGroup({
				messages: [{ id: 'm1', cursor: 1, createdAt: 1 }] as StoredChatGroup['messages']
			})
		];

		await inviteChatGroupMembers({
			groupId: 'demo',
			targets: [{ identifier: 'ref-1', expectedStablePubkey: 'aa'.repeat(32) }]
		});

		expect(fetchManyGroupMessages).toHaveBeenCalledTimes(1);
	});

	test('catches up welcome-adopted groups even when pristine', async () => {
		const { chatGroupsStore, inviteChatGroupMembers } = await import('./chatGroups.svelte');
		const consumeKeyPackage = vi.fn().mockResolvedValue({
			keyPackage: { pk: carolPk, kp_ref: 'ref-1', event: {} }
		});
		const fetchManyGroupMessages = vi.fn().mockResolvedValue({ messages: [] });
		getCoordinatorClientMock.mockReturnValue({
			ConsumeKeyPackage: consumeKeyPackage,
			FetchManyGroupMessages: fetchManyGroupMessages
		});
		// Pristine like a new conversation, but born from a Welcome at epoch 1n:
		// the coordinator can already hold post-join traffic, so the pre-op
		// catch-up must run. joinEpoch 0n is the creator marker, not "no data".
		chatGroupsStore.groups = [demoGroup({ joinEpoch: 1n })];

		await inviteChatGroupMembers({
			groupId: 'demo',
			targets: [{ identifier: 'ref-1', expectedStablePubkey: 'aa'.repeat(32) }]
		});

		expect(fetchManyGroupMessages).toHaveBeenCalledTimes(1);
	});

	test('settles a new conversation with one fetch and no listing', async () => {
		const { chatGroupsStore, inviteChatGroupMembers } = await import('./chatGroups.svelte');
		const mls = await import('$lib/services/chatMlsUtils');
		const sessions = await import('$lib/services/chatGroupSessions.svelte');

		vi.mocked(mls.findMemberLeafIndexByStablePubkey).mockReturnValue(-1);
		vi.mocked(mls.parseConsumedPublishedKeyPackage).mockResolvedValue({} as never);
		vi.mocked(mls.addMembersToGroup).mockResolvedValue({
			newState: {
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 3n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				}
			},
			commitMessageBase64: 'commit-1',
			welcome: {}
		} as never);
		vi.mocked(mls.encodeWelcomeBase64).mockReturnValue('welcome-1');
		createWorkingChatGroupSessionMock.mockReturnValue({ messages: [] });
		buildPersistedChatGroupMock.mockReturnValue(demoGroup());
		vi.mocked(sessions.syncChatGroupMessages).mockResolvedValue({
			workingGroup: { messages: [] }
		} as never);

		const consumeKeyPackage = vi.fn().mockResolvedValue({
			keyPackage: { pk: carolPk, kp_ref: 'ref-1', event: {} }
		});
		const postGroupMessage = vi.fn().mockResolvedValue({ cursor: 5, at: 1000 });
		const fetchManyGroupMessages = vi.fn().mockResolvedValue({ messages: [] });
		const listAvailableKeyPackages = vi.fn();
		getCoordinatorClientMock.mockReturnValue({
			ConsumeKeyPackage: consumeKeyPackage,
			PostGroupMessage: postGroupMessage,
			FetchManyGroupMessages: fetchManyGroupMessages,
			ListAvailableKeyPackages: listAvailableKeyPackages
		});
		chatGroupsStore.groups = [demoGroup()];

		const result = await inviteChatGroupMembers({
			groupId: 'demo',
			targets: [{ identifier: 'ref-1', expectedStablePubkey: carolPk }]
		});

		expect(result.failures).toEqual([]);
		expect(consumeKeyPackage).toHaveBeenCalledWith({ id: 'ref-1' });
		expect(postGroupMessage).toHaveBeenCalledTimes(1);
		// One settlement fetch for the whole invite: the post-commit sync pass —
		// the adopt probe reuses its bytes (no duplicate fetch), and the fresh
		// group skips the pre-op catch-up. No `after: 0` on the wire, ever.
		expect(fetchManyGroupMessages).toHaveBeenCalledTimes(1);
		expect(fetchManyGroupMessages).toHaveBeenCalledWith({
			groups: [{ gid: 'd', after: undefined }]
		});
		expect(listAvailableKeyPackages).not.toHaveBeenCalled();
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

describe('loadGroups snapshot baseline', () => {
	test('creates baseline healthy snapshot for legacy group with no snapshots', async () => {
		vi.doMock('$lib/services/chatRuntime', () => ({
			assertCoordinatorOperationActive: vi.fn(),
			getCoordinatorClient: getCoordinatorClientMock,
			requireActiveAccount: requireActiveAccountMock,
			withCoordinatorClient: withCoordinatorClientMock,
			withCoordinatorClientRetry: withCoordinatorClientMock
		}));

		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();

		const ownerPubkey = 'bb'.repeat(32);
		const groupId = 'legacy-baseline';

		// Seed storage with a group that has no snapshots and a decodable state
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 2n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
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
			assertCoordinatorOperationActive: vi.fn(),
			getCoordinatorClient: getCoordinatorClientMock,
			requireActiveAccount: requireActiveAccountMock,
			withCoordinatorClient: withCoordinatorClientMock,
			withCoordinatorClientRetry: withCoordinatorClientMock
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

describe('listChatGroupMessages()', () => {
	test('is a stable, unsorted view of the stored messages', async () => {
		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();
		const ownerPubkey = 'dd'.repeat(32);
		const groupId = 'list-view';

		const message = (id: string, cursor: number) => ({
			id,
			cursor,
			createdAt: 100 + cursor,
			direction: 'inbound' as const,
			sender: 'ee'.repeat(32),
			kind: 9,
			tags: [],
			content: id
		});

		await storage.putGroup({
			id: groupId,
			ownerPubkey,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			lastCursor: 3,
			fetchCursor: 3,
			status: 'active',
			stateBytes: new Uint8Array([1]),
			// Deliberately not cursor order: the view must not re-sort per call.
			messages: [message('m3', 3), message('m1', 1), message('m2', 2)],
			syncIssues: []
		});

		const { reloadChatGroupsForOwner, listChatGroupMessages } = await import('./chatGroups.svelte');
		await reloadChatGroupsForOwner(ownerPubkey);

		const listed = listChatGroupMessages(groupId);
		expect(listed.map((m) => m.id)).toEqual(['m3', 'm1', 'm2']);
		// Same reference every call — no copy+sort in the hot read path.
		expect(listed).toBe(listChatGroupMessages(groupId));

		await storage.deleteGroup(groupId);
	});
});

describe('repairSharedLeafRatchetDivergence (spec §10.1 repair discipline)', () => {
	const postGroupMessageMock = vi.fn(async () => ({ cursor: 42 }));

	/** Seed a stored group + load it into the store the service reads. */
	async function seedRepairGroup(groupId: string, epoch: bigint): Promise<void> {
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
				ratchetTree: [],
				groupActiveState: { kind: 'active' }
			}
		]);
		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();
		await storage.putGroup({
			id: groupId,
			ownerPubkey: 'bb'.repeat(32),
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			lastCursor: 0,
			fetchCursor: 5,
			status: 'active',
			stateBytes: new Uint8Array([1]),
			messages: [],
			syncIssues: []
		});
		const { reloadChatGroupsForOwner } = await import('./chatGroups.svelte');
		await reloadChatGroupsForOwner('bb'.repeat(32));
		requireActiveAccountMock.mockReturnValue({ pubkey: 'bb'.repeat(32) });
		getCoordinatorClientMock.mockReturnValue({
			FetchManyGroupMessages: vi.fn(async () => ({ messages: [] })),
			PostGroupMessage: postGroupMessageMock
		});
	}

	test('defers the repair when the pre-commit tip reconcile fails', async () => {
		reconcileTipForOutboundMock.mockReset();
		reconcileTipForOutboundMock.mockResolvedValue(false);
		createSelfUpdateCommitMock.mockReset();
		postGroupMessageMock.mockClear();

		const { repairSharedLeafRatchetDivergence } = await import('./chatGroups.svelte');
		await expect(repairSharedLeafRatchetDivergence('gid-repair-defer', '5')).rejects.toThrow(
			/deferring/
		);
		// The stale-state risk IS the commit: nothing may be staged or posted.
		expect(createSelfUpdateCommitMock).not.toHaveBeenCalled();
		expect(postGroupMessageMock).not.toHaveBeenCalled();
	});

	test('skips the repair when the epoch advanced since detection', async () => {
		reconcileTipForOutboundMock.mockReset();
		reconcileTipForOutboundMock.mockResolvedValue(true);
		createSelfUpdateCommitMock.mockReset();
		postGroupMessageMock.mockClear();
		await seedRepairGroup('gid-repair-stale-epoch', 6n); // detection was at epoch 5

		const { repairSharedLeafRatchetDivergence } = await import('./chatGroups.svelte');
		await repairSharedLeafRatchetDivergence('gid-repair-stale-epoch', '5');
		expect(createSelfUpdateCommitMock).not.toHaveBeenCalled();
		expect(postGroupMessageMock).not.toHaveBeenCalled();
	});

	test('commits the self-update when the reconcile succeeded at the same epoch', async () => {
		reconcileTipForOutboundMock.mockReset();
		reconcileTipForOutboundMock.mockResolvedValue(true);
		createSelfUpdateCommitMock.mockReset();
		createSelfUpdateCommitMock.mockResolvedValue({
			commitMessageBase64: 'commit-b64',
			newState: {
				groupContext: {
					epoch: 6n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
				groupMetadata: undefined
			}
		});
		createWorkingChatGroupSessionMock.mockReturnValue({ lineCursor: 5 });
		buildPersistedChatGroupMock.mockClear();
		buildPersistedChatGroupMock.mockReturnValue({
			id: 'gid-repair-commit',
			ownerPubkey: 'bb'.repeat(32),
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			stateBase64: 'AA==',
			lastCursor: 0,
			fetchCursor: 5,
			messages: [],
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n
		});
		postGroupMessageMock.mockClear();
		await seedRepairGroup('gid-repair-commit', 5n); // detection at epoch 5 — current

		const { repairSharedLeafRatchetDivergence } = await import('./chatGroups.svelte');
		await repairSharedLeafRatchetDivergence('gid-repair-commit', '5');
		expect(createSelfUpdateCommitMock).toHaveBeenCalledTimes(1);
		expect(postGroupMessageMock).toHaveBeenCalledTimes(1);
		// Own-epoch advance: the old epoch's line proof must not survive the
		// commit-intent write (the pending echo skips ingestion's clear).
		expect(buildPersistedChatGroupMock.mock.calls[0][0].workingGroup.lineCursor).toBeUndefined();
	});
});

describe('wedged-send convergence heal (staleMark + empty catch-up fetch)', () => {
	// The reported bug: two unopenable payloads set staleMark (>= STALE_SEND_RUN)
	// and every send is held with "this device may be behind". The heal: a
	// SUCCESSFUL catch-up fetch that returns nothing beyond our cursor proves
	// convergence (nothing exists out there that could change our view), so the
	// staleMark is permanently-unopenable traffic, not missed updates — clear it
	// and send. A FAILED fetch proves nothing; the hold stays.
	const sendInput = { groupId: 'held', content: 'hello' };

	function seedHeldGroup() {
		return {
			id: 'held',
			status: 'active' as const,
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 3,
			fetchCursor: 3,
			messages: [],
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n,
			staleMark: { cursor: 2, unopenableCount: 2 }
		};
	}

	beforeEach(() => {
		clientStateDecoderMock.mockReset();
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 2n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
				ratchetTree: [],
				groupActiveState: { kind: 'active' }
			}
		]);
		requireActiveAccountMock.mockReset();
		requireActiveAccountMock.mockReturnValue({ pubkey: 'bb'.repeat(32) });
		createWorkingChatGroupSessionMock.mockReset();
		createWorkingChatGroupSessionMock.mockImplementation((_group: unknown, state: unknown) => ({
			state,
			lastCursor: 3,
			fetchCursor: 3,
			messages: [],
			syncIssues: [],
			metadata: undefined,
			snapshots: []
		}));
		buildPersistedChatGroupMock.mockReset();
		buildPersistedChatGroupMock.mockImplementation(
			({ group }: { group: Record<string, unknown> }) => ({ ...group })
		);
		getCoordinatorClientMock.mockReset();
		unrecoveredDropHorizonMock.mockReset();
		unrecoveredDropHorizonMock.mockReturnValue(undefined);
		markDropIssuesRecoveredMock.mockClear();
	});

	// This suite arms shared factory mocks with send-path shapes; a later
	// suite appended below must not inherit them.
	afterEach(async () => {
		const chatGroupMessages = await import('./chatGroupMessages.svelte');
		vi.mocked(chatGroupMessages.createUnsignedCordnMessageEvent).mockReset();
		vi.mocked(chatGroupMessages.encodeAuthenticatedSender).mockReset();
		vi.mocked(chatGroupMessages.createApplicationMessageBase64).mockReset();
		const chatGroupSessions = await import('./chatGroupSessions.svelte');
		vi.mocked(chatGroupSessions.syncChatGroupMessages).mockReset();
	});

	async function armSendMocks(input: {
		fetch: ReturnType<typeof vi.fn>;
		post?: ReturnType<typeof vi.fn>;
	}) {
		getCoordinatorClientMock.mockReturnValue({
			FetchManyGroupMessages: input.fetch,
			PostGroupMessage: input.post ?? vi.fn().mockResolvedValue({ cursor: 4, at: 123 })
		});
		const chatGroupMessages = await import('./chatGroupMessages.svelte');
		vi.mocked(chatGroupMessages.createUnsignedCordnMessageEvent).mockReturnValue({
			id: 'evt-1',
			kind: 9,
			tags: [],
			content: 'hello',
			pubkey: 'bb'.repeat(32),
			createdAt: 1
		} as never);
		vi.mocked(chatGroupMessages.encodeAuthenticatedSender).mockReturnValue('ad' as never);
		vi.mocked(chatGroupMessages.createApplicationMessageBase64).mockResolvedValue({
			opaqueMessageBase64: 'opaque',
			event: { id: 'evt-1', kind: 9, tags: [], content: 'hello' },
			newState: {}
		} as never);
		const chatGroupSessions = await import('./chatGroupSessions.svelte');
		vi.mocked(chatGroupSessions.syncChatGroupMessages).mockResolvedValue({
			received: [],
			issues: [],
			ingestion: { poisoned: false }
		} as never);
	}

	test('a successful empty fetch clears the hold and the send goes through', async () => {
		const { chatGroupsStore, sendChatGroupMessage } = await import('./chatGroups.svelte');
		chatGroupsStore.groups = [seedHeldGroup()] as never;
		await armSendMocks({ fetch: vi.fn().mockResolvedValue({ messages: [] }) });

		const stored = await sendChatGroupMessage(sendInput);
		expect(stored.id).toBe('evt-1');
		expect(chatGroupsStore.groups.find((g) => g.id === 'held')?.staleMark).toBeUndefined();
	});
	test('a failed fetch proves nothing: the hold stays and the send is refused', async () => {
		const { chatGroupsStore, sendChatGroupMessage } = await import('./chatGroups.svelte');
		chatGroupsStore.groups = [seedHeldGroup()] as never;
		await armSendMocks({
			fetch: vi.fn().mockRejectedValue(new Error('Network error'))
		});

		await expect(sendChatGroupMessage(sendInput)).rejects.toThrow(/behind/i);
		expect(chatGroupsStore.groups.find((g) => g.id === 'held')?.staleMark).toEqual({
			cursor: 2,
			unopenableCount: 2
		});
	});

	test('unrecovered drop issues run their recovery pass before the clear', async () => {
		const { chatGroupsStore, sendChatGroupMessage } = await import('./chatGroups.svelte');
		chatGroupsStore.groups = [seedHeldGroup()] as never;
		// Horizon present on the pre-pass group; the recovery fetch inside the
		// ingest pass finds nothing new, marks the drops recovered, and the
		// post-pass group has no horizon left -> clear + send. The mock mirrors
		// that: the horizon exists until markDropIssuesRecovered records the pass.
		unrecoveredDropHorizonMock.mockImplementation(() =>
			markDropIssuesRecoveredMock.mock.calls.length > 0 ? undefined : 1
		);
		const fetch = vi.fn().mockResolvedValue({ messages: [] });
		await armSendMocks({ fetch });

		await sendChatGroupMessage(sendInput);
		expect(fetch).toHaveBeenCalledTimes(2); // catch-up + recovery window
		expect(markDropIssuesRecoveredMock).toHaveBeenCalled();
		expect(chatGroupsStore.groups.find((g) => g.id === 'held')?.staleMark).toBeUndefined();
	});

	test('a recovery fetch that fails keeps the hold (no proof, no clear)', async () => {
		const { chatGroupsStore, sendChatGroupMessage } = await import('./chatGroups.svelte');
		chatGroupsStore.groups = [seedHeldGroup()] as never;
		unrecoveredDropHorizonMock.mockReturnValue(1);
		await armSendMocks({
			fetch: vi.fn().mockRejectedValue(new Error('Network error'))
		});

		await expect(sendChatGroupMessage(sendInput)).rejects.toThrow(/behind|Network/i);
		expect(chatGroupsStore.groups.find((g) => g.id === 'held')?.staleMark).toEqual({
			cursor: 2,
			unopenableCount: 2
		});
	});
});

describe('store history proxying', () => {
	test('message history enters the reactive store unproxied', async () => {
		const { getChatGroup, persistGroup, StoredChatMessageList } =
			await import('./chatGroups.svelte');
		const message = {
			cursor: 1,
			createdAt: 1,
			direction: 'inbound' as const,
			sender: 'cc'.repeat(32),
			id: 'raw-1',
			kind: 9,
			tags: [],
			content: 'hi'
		};

		persistGroup({
			id: 'raw-history',
			coordinatorKey: 'aa'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 1,
			fetchCursor: 1,
			messages: [message],
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n
		} as StoredChatGroup);

		const stored = getChatGroup('raw-history');
		// Svelte's $state deep proxy skips Array subclasses (proxy.js prototype
		// check). If this fails, every stored message property became a reactive
		// source again and history scans lost their raw-array speed.
		expect(stored?.messages).toBeInstanceOf(StoredChatMessageList);
		expect(stored?.messages[0]).toBe(message);
	});
});

describe('single-group persist coalescing (latest-wins)', () => {
	const groupAt = (groupId: string, lastCursor: number) =>
		({
			id: groupId,
			ownerPubkey: 'bb'.repeat(32),
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 100,
			stateBase64: 'AA==',
			lastCursor,
			fetchCursor: lastCursor,
			messages: [],
			syncIssues: [],
			snapshots: [],
			joinEpoch: 0n
		}) as StoredChatGroup;

	test('rapid persists for one group become a single putGroup of the newest state', async () => {
		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const { persistGroup, replaceGroup } = await import('./chatGroups.svelte');
		const storage = await getChatStorage();
		const putSpy = vi.spyOn(storage, 'putGroup');
		const groupId = 'gid-persist-coalesce';

		try {
			persistGroup(groupAt(groupId, 1));
			const second = replaceGroup(groupId, groupAt(groupId, 2));
			const third = replaceGroup(groupId, groupAt(groupId, 3));
			await Promise.all([second, third]);
			// A macrotask turn lets any wrongly-scheduled extra drain settle.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const calls = putSpy.mock.calls.filter((call) => call[0]?.id === groupId);
			expect(calls).toHaveLength(1);
			expect(calls[0][0].lastCursor).toBe(3);
		} finally {
			putSpy.mockRestore();
		}
	});

	test('a delete resolves a queued persist waiter instead of hanging', async () => {
		const { chatGroupsStore, replaceGroup, deleteChatGroup } = await import('./chatGroups.svelte');
		const groupId = 'gid-delete-race';
		chatGroupsStore.groups = [groupAt(groupId, 1)];
		const pending = replaceGroup(groupId, groupAt(groupId, 2));
		// The delete lands before the coalesced write drains; the waiter must
		// still resolve (it hung forever before dropPendingGroupPersist).
		deleteChatGroup(groupId);
		await pending;
		expect(chatGroupsStore.groups.some((group) => group.id === groupId)).toBe(false);
	});
});

describe('group state facts cache', () => {
	const factsGroup = (stateBase64 = 'AA=='): StoredChatGroup =>
		({
			id: 'facts',
			coordinatorKey: 'cc'.repeat(32),
			createdAt: 1,
			stateBase64,
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			snapshots: [],
			status: 'active',
			joinEpoch: 0n
		}) as StoredChatGroup;

	test('derives members, removed and gid from one decode per state', async () => {
		clientStateDecoderMock.mockClear();
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: { groupId: new TextEncoder().encode('gid-1') },
				groupActiveState: { kind: 'active' },
				ratchetTree: []
			}
		]);
		const { chatGroupsStore, isChatGroupRemoved, getChatGroupGid, listChatGroupMembers } =
			await import('./chatGroups.svelte');
		chatGroupsStore.groups = [factsGroup()];

		const members = listChatGroupMembers('facts');
		expect(isChatGroupRemoved(chatGroupsStore.groups[0])).toBe(false);
		expect(getChatGroupGid(chatGroupsStore.groups[0])).toBe('gid-1');
		expect(members).toEqual([]);
		expect(clientStateDecoderMock).toHaveBeenCalledTimes(1);
	});

	test('re-derives the facts when the stored state bytes change', async () => {
		clientStateDecoderMock.mockClear();
		clientStateDecoderMock.mockReturnValueOnce([
			{
				groupContext: { groupId: new TextEncoder().encode('gid-1') },
				groupActiveState: { kind: 'active' },
				ratchetTree: []
			}
		]);
		const { chatGroupsStore, isChatGroupRemoved, getChatGroupGid } =
			await import('./chatGroups.svelte');
		chatGroupsStore.groups = [factsGroup()];
		expect(getChatGroupGid(chatGroupsStore.groups[0])).toBe('gid-1');

		clientStateDecoderMock.mockReturnValueOnce([
			{
				groupContext: { groupId: new TextEncoder().encode('gid-1') },
				groupActiveState: { kind: 'removedFromGroup' },
				ratchetTree: []
			}
		]);
		chatGroupsStore.groups = [factsGroup('AQ==')];
		expect(isChatGroupRemoved(chatGroupsStore.groups[0])).toBe(true);
		expect(clientStateDecoderMock).toHaveBeenCalledTimes(2);
	});
});

describe('withLegacyEmojiMediaKey()', () => {
	const secret = new Uint8Array(32).fill(9);

	beforeEach(() => {
		clientStateDecoderMock.mockReset();
		clientStateDecoderMock.mockReturnValue([{ keySchedule: { exporterSecret: secret } }]);
	});

	function group(): StoredChatGroup {
		return { id: 'legacy', stateBase64: 'AA==' } as unknown as StoredChatGroup;
	}

	function row(cursor: number, mediaKeyBase64?: string): StoredChatMessage {
		return {
			cursor,
			createdAt: cursor,
			direction: 'inbound',
			sender: 'cc'.repeat(32),
			id: `ev-${cursor}`,
			kind: 9,
			tags: [
				['emoji-media', 'name what_dog', 'url https://blob.example/x.bin', 'm image/gif'],
				['imeta', 'url https://blob.example/y.bin']
			],
			content: ':what_dog:',
			mediaKeyBase64
		};
	}

	test('hands the current epoch key to keyless emoji-media rows only', async () => {
		const { withLegacyEmojiMediaKey } = await import('./chatGroups.svelte');
		const { deriveMediaKey } = await import('./chatMediaCrypto');
		const { bytesToBase64 } = await vi.importActual<typeof import('ts-mls')>('ts-mls');
		const expected = bytesToBase64(
			await deriveMediaKey({ keySchedule: { exporterSecret: secret } } as never)
		);
		const keyed: StoredChatMessage = { ...row(2), mediaKeyBase64: 'kept' };
		const plain: StoredChatMessage = { ...row(3), tags: [] };

		const out = await withLegacyEmojiMediaKey(group(), [row(1), keyed, plain]);

		expect(out[0].mediaKeyBase64).toBe(expected);
		expect(out[1].mediaKeyBase64).toBe('kept');
		expect(out[2].mediaKeyBase64).toBeUndefined();
		// Untouched arrays stay the same reference (no per-page copies).
		const unchanged = [plain];
		expect(await withLegacyEmojiMediaKey(group(), unchanged)).toBe(unchanged);
	});

	test('returns rows unchanged when the stored state cannot be decoded', async () => {
		clientStateDecoderMock.mockReturnValue(undefined);
		const { withLegacyEmojiMediaKey } = await import('./chatGroups.svelte');
		const messages = [row(1)];

		expect(await withLegacyEmojiMediaKey(group(), messages)).toBe(messages);
	});
});

describe('runChatGroupCatchUpCheck()', () => {
	const myPk = 'bb'.repeat(32);
	const dropIssue = {
		cursor: 10,
		createdAt: 1,
		detail: 'Sealed payload decrypt failed: invalid tag'
	};
	const laterDropIssue = { ...dropIssue, cursor: 12 };

	function snapshot(groupId: string, cursor: number) {
		return {
			groupId,
			status: 'healthy' as const,
			epoch: '2',
			cursor,
			createdAt: 1,
			stateBase64: 'AA=='
		};
	}

	function makeGroup(id: string): StoredChatGroup {
		return {
			id,
			ownerPubkey: myPk,
			coordinatorKey: 'ee'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 30,
			fetchCursor: 30,
			messages: [],
			syncIssues: [dropIssue, laterDropIssue],
			firstUnopenedCursor: 10,
			snapshots: [snapshot(id, 0), snapshot(id, 5)],
			joinEpoch: 2n,
			metadata: { name: 'demo' }
		} as StoredChatGroup;
	}

	function row(cursor: number): StoredChatMessage {
		return {
			cursor,
			createdAt: cursor,
			direction: 'inbound',
			sender: myPk,
			id: `ev-${cursor}`,
			kind: 9,
			tags: [],
			content: `message ${cursor}`
		};
	}

	beforeEach(() => {
		clientStateDecoderMock.mockReset();
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 2n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
				ratchetTree: [],
				groupActiveState: { kind: 'active' }
			}
		]);
		requireActiveAccountMock.mockReset();
		requireActiveAccountMock.mockReturnValue({ pubkey: myPk });
		createWorkingChatGroupSessionMock.mockReset();
		createWorkingChatGroupSessionMock.mockImplementation(
			(group: StoredChatGroup, state: unknown) => ({
				...group,
				state,
				messages: [...group.messages],
				syncIssues: [...group.syncIssues]
			})
		);
		ingestChatGroupMessagesMock.mockReset();
		markDropIssuesRecoveredMock.mockClear();
		getCoordinatorClientMock.mockReset();
	});

	test('replays from cursor 0 without an after, keeps live state, filters durable rows', async () => {
		const { chatGroupsStore, runChatGroupCatchUpCheck } = await import('./chatGroups.svelte');
		const { getChatStorage } = await import('$lib/storage/chatStorage');
		const storage = await getChatStorage();
		const group = makeGroup('catch-up-success');
		await storage.putGroup({
			id: group.id,
			ownerPubkey: myPk,
			coordinatorKey: group.coordinatorKey,
			createdAt: 1,
			lastCursor: 0,
			fetchCursor: 0,
			status: 'active',
			stateBytes: new Uint8Array([1]),
			messages: [row(10)],
			syncIssues: []
		});
		chatGroupsStore.groups = [group];

		const fetch = vi.fn().mockResolvedValue({
			messages: [
				{ gid: 'd', cursor: 3, at: 0, msg_64: 'm3' },
				{ gid: 'd', cursor: 10, at: 1, msg_64: 'm10' },
				{ gid: 'd', cursor: 30, at: 2, msg_64: 'm30' }
			]
		});
		getCoordinatorClientMock.mockReturnValue({ FetchManyGroupMessages: fetch });
		ingestChatGroupMessagesMock.mockImplementation(async ({ group: working }) => ({
			received: working.id?.endsWith(':0') ? [row(10), row(30)] : []
		}));

		const result = await runChatGroupCatchUpCheck(group.id);

		expect(fetch).toHaveBeenCalledWith({ groups: [{ gid: 'd', after: undefined }] });
		// Each snapshot sees only what came after it: replaying cursor 3 on the
		// cursor-5 state would re-apply messages that state already contains.
		expect(
			ingestChatGroupMessagesMock.mock.calls.map(([input]) =>
				input.messages.map((message: StoredChatMessage) => message.cursor)
			)
		).toEqual([
			[3, 10, 30],
			[10, 30]
		]);
		expect(result).toEqual({
			checked: 3,
			recovered: 1,
			snapshots: 2,
			failedSnapshots: 0,
			fromCursor: 0
		});
		const after = chatGroupsStore.groups.find((candidate) => candidate.id === group.id)!;
		// Live MLS state, cursors and snapshots are untouched; only the missing
		// non-durable row is merged into the window.
		expect(after.stateBase64).toBe(group.stateBase64);
		expect(after.fetchCursor).toBe(30);
		expect(after.lastCursor).toBe(30);
		expect(after.snapshots).toEqual(group.snapshots);
		expect(after.messages.map((message) => message.cursor)).toEqual([30]);
		// Cursor 10 is durable/open; 12 never opened, so the frontier moves there
		// instead of clearing (the warning must survive a partial recovery).
		expect(after.firstUnopenedCursor).toBe(12);
		expect(markDropIssuesRecoveredMock).toHaveBeenCalledWith(group.syncIssues, 0);

		await storage.deleteGroup(group.id);
	});

	test('merges rows a partial replay opened but leaves issue and frontier state alone', async () => {
		const { chatGroupsStore, runChatGroupCatchUpCheck } = await import('./chatGroups.svelte');
		const group = makeGroup('catch-up-partial');
		chatGroupsStore.groups = [group];
		getCoordinatorClientMock.mockReturnValue({
			FetchManyGroupMessages: vi.fn().mockResolvedValue({ messages: [] })
		});
		ingestChatGroupMessagesMock.mockResolvedValue({ received: [row(10), row(30)] });
		createWorkingChatGroupSessionMock.mockImplementationOnce(() => {
			throw new Error('broken snapshot');
		});

		const result = await runChatGroupCatchUpCheck(group.id);

		expect(result).toEqual({
			checked: 0,
			recovered: 2,
			snapshots: 2,
			failedSnapshots: 1,
			fromCursor: 0
		});
		// A partial replay proves nothing about the drop window: no issue may be
		// marked recovered. Rows it did open are real, and the frontier must move
		// past the one that opened or it would stay stuck on a seen cursor.
		expect(markDropIssuesRecoveredMock).not.toHaveBeenCalled();
		const after = chatGroupsStore.groups.find((candidate) => candidate.id === group.id)!;
		expect(after.stateBase64).toBe(group.stateBase64);
		expect(after.messages.map((message) => message.cursor)).toEqual([10, 30]);
		expect(after.syncIssues).toEqual(group.syncIssues);
		expect(after.firstUnopenedCursor).toBe(12);
	});
});

describe('repairChatGroup()', () => {
	const myPk = 'bb'.repeat(32);

	function snapshot(groupId: string, cursor: number) {
		return {
			groupId,
			status: 'healthy' as const,
			epoch: '9',
			cursor,
			createdAt: 1,
			stateBase64: 'AA=='
		};
	}

	function makeGroup(id: string): StoredChatGroup {
		return {
			id,
			ownerPubkey: myPk,
			coordinatorKey: 'ee'.repeat(32),
			createdAt: 1,
			stateBase64: 'AA==',
			lastCursor: 457,
			fetchCursor: 457,
			messages: [row(336), row(337)],
			syncIssues: [
				{ cursor: 338, createdAt: 1, detail: 'Sealed payload decrypt failed: invalid tag' }
			],
			staleMark: { cursor: 338, unopenableCount: 933 },
			firstUnopenedCursor: 338,
			snapshots: [snapshot(id, 457)],
			appliedDocument: { address: 'bad-doc', cursor: 297, fingerprint: '9:old' },
			epochFingerprints: { '9': 'old' },
			branch: { kind: 'live', sinceEpoch: '9' },
			skippedSiblingCommit: { epoch: '9', cursor: 206 },
			joinEpoch: 9n,
			metadata: { name: 'demo' }
		} as StoredChatGroup;
	}

	function row(cursor: number): StoredChatMessage {
		return {
			cursor,
			createdAt: cursor,
			direction: 'inbound',
			sender: myPk,
			id: `ev-${cursor}`,
			kind: 9,
			tags: [],
			content: `message ${cursor}`
		};
	}

	function fetchedMessages(count: number) {
		return Array.from({ length: count }, (_, index) => ({
			gid: 'd',
			cursor: index + 1,
			at: index + 1,
			msg_64: `m${index + 1}`
		}));
	}

	beforeEach(() => {
		clientStateDecoderMock.mockReset();
		clientStateDecoderMock.mockReturnValue([
			{
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 9n,
					treeHash: new Uint8Array([1]),
					confirmedTranscriptHash: new Uint8Array([2])
				},
				ratchetTree: [],
				groupActiveState: { kind: 'active' }
			}
		]);
		requireActiveAccountMock.mockReset();
		requireActiveAccountMock.mockReturnValue({ pubkey: myPk });
		createWorkingChatGroupSessionMock.mockReset();
		createWorkingChatGroupSessionMock.mockImplementation(
			(group: StoredChatGroup, state: unknown) => ({
				...group,
				state,
				messages: [...group.messages],
				syncIssues: [...group.syncIssues]
			})
		);
		ingestChatGroupMessagesMock.mockReset();
		getCoordinatorClientMock.mockReset();
	});

	test('replays the skipped commits and adopts the newer state', async () => {
		const { chatGroupsStore, repairChatGroup } = await import('./chatGroups.svelte');
		const group = makeGroup('repair-incident');
		chatGroupsStore.groups = [group];
		const fetch = vi.fn().mockResolvedValue({ messages: fetchedMessages(457) });
		getCoordinatorClientMock.mockReturnValue({ FetchManyGroupMessages: fetch });
		ingestChatGroupMessagesMock.mockImplementation(
			async ({
				group: working,
				messages
			}: {
				group: Record<string, unknown>;
				messages: Array<{ cursor: number }>;
			}) => {
				working.state = {
					groupContext: {
						groupId: new Uint8Array([100]),
						epoch: 15n,
						treeHash: new Uint8Array([3]),
						confirmedTranscriptHash: new Uint8Array([4])
					},
					groupActiveState: { kind: 'active' }
				};
				working.status = 'active';
				const failed = messages.filter(
					(message) => message.cursor <= 204 || message.cursor === 336 || message.cursor === 337
				);
				return {
					received: messages
						.filter((message) => !failed.some((issue) => issue.cursor === message.cursor))
						.map((message) => row(message.cursor)),
					issues: failed.map((message) => ({
						cursor: message.cursor,
						createdAt: message.cursor,
						detail: 'Sealed payload decrypt failed: invalid tag'
					}))
				};
			}
		);

		const result = await repairChatGroup(group.id);

		expect(fetch).toHaveBeenCalledWith({ groups: [{ gid: 'd' }] });
		expect(result).toEqual({
			repaired: true,
			removed: false,
			checked: 457,
			recovered: 251,
			oldEpoch: '9',
			newEpoch: '15'
		});
		const after = chatGroupsStore.groups.find((candidate) => candidate.id === group.id)!;
		expect(after.stateBase64).toBe('AQ==');
		expect(after.fetchCursor).toBe(457);
		expect(after.lastCursor).toBe(457);
		expect(after.staleMark).toBeUndefined();
		expect(after.firstUnopenedCursor).toBeUndefined();
		expect(after.skippedSiblingCommit).toBeUndefined();
		expect(after.appliedDocument).toBeUndefined();
		expect(after.syncIssues).toEqual([]);
		expect(after.snapshots).toHaveLength(1);
		expect(after.snapshots[0]).toMatchObject({ status: 'healthy', epoch: '15', cursor: 457 });
		expect(after.messages[0].cursor).toBe(205);
		expect(after.messages.at(-1)?.cursor).toBe(457);
		expect(after.messages.map((message) => message.cursor)).toContain(336);
		expect(after.epochFingerprints?.['15']).toBeDefined();
	});

	test('writes nothing when the replay does not advance the epoch', async () => {
		const { chatGroupsStore, repairChatGroup } = await import('./chatGroups.svelte');
		const group = makeGroup('repair-no-advance');
		group.messages = [row(10)];
		group.fetchCursor = 10;
		group.lastCursor = 10;
		chatGroupsStore.groups = [group];
		getCoordinatorClientMock.mockReturnValue({
			FetchManyGroupMessages: vi.fn().mockResolvedValue({ messages: fetchedMessages(10) })
		});
		ingestChatGroupMessagesMock.mockResolvedValue({
			received: [row(10)],
			issues: []
		});

		const result = await repairChatGroup(group.id);

		expect(result).toEqual({
			repaired: false,
			removed: false,
			checked: 10,
			recovered: 0,
			oldEpoch: '9',
			newEpoch: '9'
		});
		const after = chatGroupsStore.groups.find((candidate) => candidate.id === group.id)!;
		expect(after.stateBase64).toBe('AA==');
		expect(after.fetchCursor).toBe(10);
		expect(after.messages).toEqual(group.messages);
	});

	test('does not adopt a poisoned replay', async () => {
		const { chatGroupsStore, repairChatGroup } = await import('./chatGroups.svelte');
		const group = makeGroup('repair-poisoned');
		group.messages = [row(10)];
		group.fetchCursor = 10;
		group.lastCursor = 10;
		chatGroupsStore.groups = [group];
		getCoordinatorClientMock.mockReturnValue({
			FetchManyGroupMessages: vi.fn().mockResolvedValue({ messages: fetchedMessages(10) })
		});
		ingestChatGroupMessagesMock.mockResolvedValue({
			received: [row(10)],
			issues: [],
			poisoned: true
		});

		const result = await repairChatGroup(group.id);

		expect(result.repaired).toBe(false);
		const after = chatGroupsStore.groups.find((candidate) => candidate.id === group.id)!;
		expect(after.stateBase64).toBe('AA==');
		expect(after.fetchCursor).toBe(10);
	});

	test('reports removal instead of a sending-available repair', async () => {
		const { chatGroupsStore, repairChatGroup } = await import('./chatGroups.svelte');
		const group = makeGroup('repair-removed');
		group.messages = [];
		group.fetchCursor = 10;
		group.lastCursor = 10;
		chatGroupsStore.groups = [group];
		getCoordinatorClientMock.mockReturnValue({
			FetchManyGroupMessages: vi.fn().mockResolvedValue({ messages: fetchedMessages(10) })
		});
		ingestChatGroupMessagesMock.mockImplementation(async ({ group: working }) => {
			working.state = {
				groupContext: {
					groupId: new Uint8Array([100]),
					epoch: 10n,
					treeHash: new Uint8Array([3]),
					confirmedTranscriptHash: new Uint8Array([4])
				}
			};
			working.removedAtCursor = 10;
			return { received: [row(10)], issues: [], removedLocalMember: true };
		});

		const result = await repairChatGroup(group.id);

		expect(result).toMatchObject({ repaired: true, removed: true });
		expect(chatGroupsStore.groups[0].status).toBe('removed');
	});

	test('writes nothing when a replay leaves unresolved history', async () => {
		const { chatGroupsStore, repairChatGroup } = await import('./chatGroups.svelte');
		const group = makeGroup('repair-partial');
		group.messages = [];
		group.firstUnopenedCursor = 10;
		group.staleMark = { cursor: 10, unopenableCount: 2 };
		chatGroupsStore.groups = [group];
		getCoordinatorClientMock.mockReturnValue({
			FetchManyGroupMessages: vi.fn().mockResolvedValue({ messages: fetchedMessages(30) })
		});
		ingestChatGroupMessagesMock.mockImplementation(
			async ({
				group: working,
				messages
			}: {
				group: Record<string, unknown>;
				messages: Array<{ cursor: number }>;
			}) => {
				working.state = {
					groupContext: {
						groupId: new Uint8Array([100]),
						epoch: 10n,
						treeHash: new Uint8Array([3]),
						confirmedTranscriptHash: new Uint8Array([4])
					},
					groupActiveState: { kind: 'active' }
				};
				const failed = messages.filter((message) => message.cursor !== 10 && message.cursor !== 19);
				return {
					received: messages
						.filter((message) => message.cursor === 10 || message.cursor === 19)
						.map((message) => row(message.cursor)),
					issues: failed.map((message) => ({
						cursor: message.cursor,
						createdAt: message.cursor,
						detail: 'Sealed payload decrypt failed: invalid tag'
					}))
				};
			}
		);

		const result = await repairChatGroup(group.id);

		expect(result).toEqual({
			repaired: false,
			removed: false,
			checked: 30,
			recovered: 0,
			oldEpoch: '9',
			newEpoch: '10'
		});
		const after = chatGroupsStore.groups.find((candidate) => candidate.id === group.id)!;
		expect(after.stateBase64).toBe('AA==');
		expect(after.fetchCursor).toBe(457);
		expect(after.messages).toEqual([]);
		expect(after.snapshots).toEqual([snapshot(group.id, 457)]);
		expect(after.firstUnopenedCursor).toBe(10);
		expect(after.staleMark).toEqual({ cursor: 10, unopenableCount: 2 });
	});
});
