import { describe, expect, test } from 'vitest';
import {
	createGroup,
	generateKeyPackage,
	getGroupMembers,
	unsafeTestingAuthenticationService
} from 'ts-mls';
import {
	addMembersToGroup,
	createCordnMetadataCapabilities,
	createCredential,
	encodeWelcomeBase64,
	getCordnCipherSuite,
	joinGroupFromWelcome
} from './chatMlsUtils';

describe('addMembersToGroup()', () => {
	test('adds multiple members in one commit with a single welcome covering all joiners', async () => {
		const cipherSuite = await getCordnCipherSuite();
		const context = { cipherSuite, authService: unsafeTestingAuthenticationService };

		const creator = await generateKeyPackage({
			credential: createCredential('aa'.repeat(32)),
			capabilities: createCordnMetadataCapabilities(),
			cipherSuite
		});
		const state = await createGroup({
			context,
			groupId: new TextEncoder().encode('batch-add-test'),
			keyPackage: creator.publicPackage,
			privateKeyPackage: creator.privatePackage
		});

		const joiners = await Promise.all(
			['bb'.repeat(32), 'cc'.repeat(32)].map((stablePubkey) =>
				generateKeyPackage({
					credential: createCredential(stablePubkey),
					capabilities: createCordnMetadataCapabilities(),
					cipherSuite
				})
			)
		);

		const result = await addMembersToGroup({
			state,
			memberKeyPackages: joiners.map((joiner) => joiner.publicPackage)
		});

		expect(result.newState.groupContext.epoch).toBe(1n);
		expect(getGroupMembers(result.newState)).toHaveLength(3);
		expect(result.welcome.secrets).toHaveLength(2);

		const welcomeBase64 = encodeWelcomeBase64(result.welcome);
		const joinedStates = await Promise.all(
			joiners.map((joiner) =>
				joinGroupFromWelcome({
					welcomeBase64,
					keyPackage: joiner.publicPackage,
					privateKeyPackage: joiner.privatePackage
				})
			)
		);
		for (const joinedState of joinedStates) {
			expect(joinedState.groupContext.epoch).toBe(1n);
			expect(getGroupMembers(joinedState)).toHaveLength(3);
		}
	});
});
