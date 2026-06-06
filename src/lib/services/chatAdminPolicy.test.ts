import { defaultProposalTypes } from 'ts-mls';
import { describe, expect, test } from 'vitest';

import {
	assertCanAdministerGroup,
	commitRequiresAdmin,
	createAdminAuthorizationCallback,
	createUnauthorizedAdminRejectionDetail,
	getGroupAdminPubkeys,
	isEgalitarianGroup,
	isGroupAdmin,
	proposalRequiresAdmin,
	UnauthorizedGroupAdminActionError
} from './chatAdminPolicy';

function createStateWithMembers(pubkeys: string[]) {
	return {
		ratchetTree: pubkeys.flatMap((pubkey) => [
			{
				nodeType: 1,
				leaf: { credential: { identity: new TextEncoder().encode(pubkey) } }
			},
			undefined
		])
	} as never;
}

describe('chat admin policy', () => {
	test('normalizes configured admin pubkeys and detects egalitarian mode', () => {
		expect(getGroupAdminPubkeys()).toEqual([]);
		expect(isEgalitarianGroup()).toBe(true);

		const metadata = { name: 'demo', adminPubkeys: ['AA'.repeat(32), 'bb'.repeat(32)] };

		expect(getGroupAdminPubkeys(metadata)).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
		expect(isEgalitarianGroup(metadata)).toBe(false);
	});

	test('treats egalitarian groups as open and restricted groups as explicit', () => {
		expect(isGroupAdmin({ stablePubkey: 'aa'.repeat(32) })).toBe(true);

		const metadata = { name: 'demo', adminPubkeys: ['aa'.repeat(32)] };

		expect(isGroupAdmin({ metadata, stablePubkey: 'aa'.repeat(32) })).toBe(true);
		expect(isGroupAdmin({ metadata, stablePubkey: 'bb'.repeat(32) })).toBe(false);
	});

	test('throws for unauthorized outbound admin actions', () => {
		expect(() =>
			assertCanAdministerGroup({
				groupId: 'demo',
				metadata: { name: 'demo', adminPubkeys: ['aa'.repeat(32)] },
				stablePubkey: 'bb'.repeat(32)
			})
		).toThrow(UnauthorizedGroupAdminActionError);
	});

	test('detects which proposals require admin authorization', () => {
		expect(
			commitRequiresAdmin({ proposals: [{ proposal: { proposalType: defaultProposalTypes.add } }] })
		).toBe(true);
		expect(
			commitRequiresAdmin({
				proposals: [{ proposal: { proposalType: defaultProposalTypes.group_context_extensions } }]
			})
		).toBe(true);
		expect(
			proposalRequiresAdmin({
				proposal: { proposal: { proposalType: defaultProposalTypes.remove } }
			})
		).toBe(true);
		expect(
			commitRequiresAdmin({
				proposals: [{ proposal: { proposalType: defaultProposalTypes.update } }]
			})
		).toBe(false);
	});

	test('accepts egalitarian admin proposals', () => {
		const callback = createAdminAuthorizationCallback({
			state: createStateWithMembers(['aa'.repeat(32)])
		});

		expect(
			callback({
				kind: 'proposal',
				proposal: { senderLeafIndex: 0, proposal: { proposalType: defaultProposalTypes.add } }
			} as never)
		).toBe('accept');
	});

	test('rejects unauthorized admin proposals from non-admin senders', () => {
		const callback = createAdminAuthorizationCallback({
			state: createStateWithMembers(['aa'.repeat(32), 'bb'.repeat(32)]),
			metadata: { name: 'demo', adminPubkeys: ['aa'.repeat(32)] }
		});

		expect(
			callback({
				kind: 'commit',
				senderLeafIndex: 1,
				proposals: [{ proposal: { proposalType: defaultProposalTypes.remove } }]
			} as never)
		).toBe('reject');
	});

	test('accepts non-admin proposal types without admin checks', () => {
		const callback = createAdminAuthorizationCallback({
			state: createStateWithMembers([]),
			metadata: { name: 'demo', adminPubkeys: ['aa'.repeat(32)] }
		});

		expect(
			callback({
				kind: 'proposal',
				proposal: {
					senderLeafIndex: undefined,
					proposal: { proposalType: defaultProposalTypes.update }
				}
			} as never)
		).toBe('accept');
	});

	test('formats unauthorized rejection details directly', () => {
		expect(createUnauthorizedAdminRejectionDetail({ groupId: 'demo' })).toBe(
			'Rejected unauthorized admin action in group demo'
		);
	});
});
