import { describe, expect, test, vi, beforeEach } from 'vitest';

const { processMessageMock, mlsMessageDecoderMock } = vi.hoisted(() => ({
	processMessageMock: vi.fn(),
	mlsMessageDecoderMock: vi.fn(() => [{ wireformat: 2 }, 1])
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
});
