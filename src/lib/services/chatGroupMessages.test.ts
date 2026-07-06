import { describe, expect, test, vi, beforeEach } from 'vitest';

const { processMessageMock, mlsMessageDecoderMock } = vi.hoisted(() => ({
	processMessageMock: vi.fn(),
	mlsMessageDecoderMock: vi.fn<
		(
			bytes: unknown,
			offset: number
		) => [{ wireformat: number; privateMessage?: { epoch: bigint; contentType: number } }, number]
	>(() => [{ wireformat: 2 }, 1])
}));

vi.mock('ts-mls', async () => {
	const actual = await vi.importActual<typeof import('ts-mls')>('ts-mls');
	return {
		...actual,
		processMessage: processMessageMock,
		mlsMessageDecoder: mlsMessageDecoderMock
	};
});

vi.mock('$lib/services/chatMlsUtils', async () => {
	const actual = await vi.importActual<typeof import('$lib/services/chatMlsUtils')>(
		'$lib/services/chatMlsUtils'
	);
	return {
		...actual,
		getCordnCipherSuite: vi.fn(async () => ({})),
		getCordnGroupMetadataExtension: vi.fn((state) => state.groupMetadata)
	};
});

import { ingestChatGroupMessages } from './chatGroupMessages.svelte';

describe('ingestChatGroupMessages()', () => {
	beforeEach(() => {
		processMessageMock.mockReset();
		mlsMessageDecoderMock.mockReset();
		mlsMessageDecoderMock.mockReturnValue([{ wireformat: 2 }, 1]);
	});

	test('records admin-policy rejections as sync issues', async () => {
		processMessageMock.mockResolvedValueOnce({
			kind: 'newState',
			actionTaken: 'reject'
		});

		const group = {
			state: {
				ratchetTree: [],
				groupMetadata: { name: 'demo', adminPubkeys: ['aa'.repeat(32)] }
			} as never,
			metadata: { name: 'demo', adminPubkeys: ['aa'.repeat(32)] },
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: []
		};

		const result = await ingestChatGroupMessages({
			group,
			messages: [{ cursor: 7, createdAt: 130, opaqueMessageBase64: 'unauthorized-admin-commit' }]
		});

		expect(result.issues).toEqual([
			{
				cursor: 7,
				createdAt: 130,
				detail: 'Rejected unauthorized admin action in group demo'
			}
		]);
		expect(group.syncIssues).toEqual(result.issues);
		expect(group.fetchCursor).toBe(7);
		expect(group.lastCursor).toBe(7);
	});

	test('skips a sibling commit (own shared leaf) instead of self-removing', async () => {
		// spec/applications/multi-device.md §10: a Commit from our own shared leaf
		// must be skipped, not ingested. processMessage invokes the callback with
		// the Commit's senderLeafIndex before applying the UpdatePath; the guard
		// throws a sentinel that the loop turns into a skip (cursor advances, a
		// sync issue is recorded, the group stays active and is NOT poisoned).
		const ownPubkey = 'ab'.repeat(32);
		// MLS ratchet-tree convention (see chatAdminPolicy.test.ts): a leaf at
		// tree index i has leafIndex i/2. Put our identity at leafIndex 1
		// (tree index 2) and have the Commit arrive from that leaf.
		const ratchetTree = [
			undefined,
			undefined,
			{
				nodeType: 1,
				leaf: { credential: { identity: new TextEncoder().encode(ownPubkey) } }
			}
		];

		processMessageMock.mockImplementationOnce(async ({ callback }) => {
			// Authorization callback fires before the UpdatePath is applied.
			await callback?.({ kind: 'commit', senderLeafIndex: 1 } as never);
			return { kind: 'newState', actionTaken: 'accept' } as never;
		});

		const group = {
			state: {
				ratchetTree,
				groupMetadata: { name: 'demo', adminPubkeys: [] }
			} as never,
			metadata: { name: 'demo' },
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			status: 'active' as const
		};

		const result = await ingestChatGroupMessages({
			group,
			localStablePubkey: ownPubkey,
			messages: [{ cursor: 9, createdAt: 200, opaqueMessageBase64: 'sibling-commit' }]
		});

		expect(group.status).toBe('active');
		expect(result.poisoned).toBe(false);
		expect(result.removedLocalMember).toBe(false);
		expect(group.fetchCursor).toBe(9);
		expect(group.lastCursor).toBe(9);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]?.cursor).toBe(9);
		expect(result.issues[0]?.detail).toMatch(/sibling commit/i);
	});

	test('skips an ahead-of-local-epoch message when MD is active (no poison)', async () => {
		// spec/applications/multi-device.md §10: behind a sibling Commit or
		// pre-reconcile, an app message at a newer epoch is undecryptable here.
		// The group document owns that epoch, so skip + await fast-forward;
		// never poison (would silently fork the device out of the group).
		mlsMessageDecoderMock.mockReturnValue([
			{ wireformat: 2, privateMessage: { epoch: 7n, contentType: 1 } },
			1
		]);
		processMessageMock.mockRejectedValueOnce(new Error('OperationError: The operation failed'));

		const group = {
			state: {
				groupContext: { epoch: 5n },
				ratchetTree: [],
				groupMetadata: { name: 'demo', adminPubkeys: [] }
			} as never,
			metadata: { name: 'demo' },
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			status: 'active' as const
		};

		const result = await ingestChatGroupMessages({
			group,
			mdActive: true,
			messages: [{ cursor: 11, createdAt: 300, opaqueMessageBase64: 'ahead-app-message' }]
		});

		expect(group.status).toBe('active');
		expect(result.poisoned).toBe(false);
		// Cursor is NOT advanced: the message stays re-fetchable so a chained
		// catch-up (spec §8.5) can recover it once the chain state arrives.
		expect(group.fetchCursor).toBe(0);
		expect(group.lastCursor).toBe(0);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]?.cursor).toBe(11);
		expect(result.issues[0]?.detail).toMatch(/ahead of local epoch 5/i);
	});

	test('dedups the ahead-of-epoch advisory issue across re-fetches (cursor not advanced)', async () => {
		// Because the cursor is left at the decrypt frontier, a backlog re-fetch
		// (e.g. reconnect) re-delivers the same ahead-of-epoch cursor until
		// catch-up resolves it. The advisory issue must not pile up per re-fetch.
		mlsMessageDecoderMock.mockReturnValue([
			{ wireformat: 2, privateMessage: { epoch: 7n, contentType: 1 } },
			1
		]);
		processMessageMock.mockRejectedValue(new Error('OperationError: The operation failed'));

		const group = {
			state: {
				groupContext: { epoch: 5n },
				ratchetTree: [],
				groupMetadata: { name: 'demo', adminPubkeys: [] }
			} as never,
			metadata: { name: 'demo' },
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [] as Array<{ cursor: number; createdAt: number; detail: string }>,
			status: 'active' as const
		};

		const msg = { cursor: 11, createdAt: 300, opaqueMessageBase64: 'ahead-app-message' };
		await ingestChatGroupMessages({ group, mdActive: true, messages: [msg] });
		await ingestChatGroupMessages({ group, mdActive: true, messages: [msg] });

		expect(group.syncIssues.filter((i) => i.cursor === 11)).toHaveLength(1);
		expect(group.fetchCursor).toBe(0);
	});

	test('poisons on the same ahead-of-local-epoch message when MD is inactive', async () => {
		// The MD gate is precise: without multi-device there is no document
		// rescue, so an undecryptable ahead-of-local message is a genuine
		// corruption signal and the group is poisoned as before.
		mlsMessageDecoderMock.mockReturnValue([
			{ wireformat: 2, privateMessage: { epoch: 7n, contentType: 1 } },
			1
		]);
		processMessageMock.mockRejectedValueOnce(new Error('OperationError: The operation failed'));

		const group = {
			state: {
				groupContext: { epoch: 5n },
				ratchetTree: [],
				groupMetadata: { name: 'demo', adminPubkeys: [] }
			} as never,
			metadata: { name: 'demo' },
			lastCursor: 0,
			fetchCursor: 0,
			messages: [],
			syncIssues: [],
			status: 'active' as const,
			poisonedAtCursor: undefined as number | undefined
		};

		const result = await ingestChatGroupMessages({
			group,
			mdActive: false,
			messages: [{ cursor: 11, createdAt: 300, opaqueMessageBase64: 'ahead-app-message' }]
		});

		expect(result.poisoned).toBe(true);
		expect(group.status).toBe('poisoned');
		expect(group.poisonedAtCursor).toBe(11);
	});
});
