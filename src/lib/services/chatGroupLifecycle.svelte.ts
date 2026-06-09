import {
	createGroup,
	unsafeTestingAuthenticationService,
	type KeyPackage,
	type PrivateKeyPackage
} from 'ts-mls';

import type { StoredKeyPackageRecord } from '$lib/services/chatKeyPackages.svelte';
import { decodeStoredKeyPackage, getChatKeyPackage } from '$lib/services/chatKeyPackages.svelte';
import {
	getCordnCipherSuite,
	getCordnGroupMetadataExtension,
	isLastResortKeyPackage,
	joinGroupFromWelcome,
	makeCordnGroupMetadataExtension,
	type CordnGroupMetadata
} from '$lib/services/chatMlsUtils';
import type { StoredChatGroup } from '$lib/services/chatGroups.svelte';
import type { WelcomeNotificationEntry } from '$lib/services/chatWelcomeNotifications.svelte';

const groupIdDecoder = new TextDecoder();

export interface GroupMetadataInput extends CordnGroupMetadata {
	name: string;
}

export async function createMemberArtifacts(params: {
	selectedKeyPackageRef?: string;
	createKeyPackage: () => Promise<{
		keyPackage: KeyPackage;
		privateKeyPackage: PrivateKeyPackage;
		record: StoredKeyPackageRecord;
	}>;
}): Promise<{
	keyPackage: KeyPackage;
	privateKeyPackage: PrivateKeyPackage;
	keyPackageRef: string;
}> {
	if (params.selectedKeyPackageRef) {
		const storedRecord = getChatKeyPackage(params.selectedKeyPackageRef);
		if (!storedRecord) {
			throw new Error('Selected key package was not found');
		}

		const decoded = decodeStoredKeyPackage(storedRecord);
		if (storedRecord.isLastResort && !isLastResortKeyPackage(decoded.keyPackage)) {
			throw new Error(
				'Legacy last-resort key packages are not compatible with ts-mls rc.12. Generate a new last-resort key package and retry.'
			);
		}
		return {
			keyPackage: decoded.keyPackage,
			privateKeyPackage: decoded.privateKeyPackage,
			keyPackageRef: storedRecord.keyPackageRef
		};
	}

	const createdKeyPackage = await params.createKeyPackage();
	return {
		keyPackage: createdKeyPackage.keyPackage,
		privateKeyPackage: createdKeyPackage.privateKeyPackage,
		keyPackageRef: createdKeyPackage.record.keyPackageRef
	};
}

export async function createInitialGroupState(params: {
	metadata: GroupMetadataInput;
	memberArtifacts: {
		keyPackage: KeyPackage;
		privateKeyPackage: PrivateKeyPackage;
	};
}) {
	const cipherSuite = await getCordnCipherSuite();
	return createGroup({
		context: { cipherSuite, authService: unsafeTestingAuthenticationService },
		groupId: new TextEncoder().encode(crypto.randomUUID()),
		keyPackage: params.memberArtifacts.keyPackage,
		privateKeyPackage: params.memberArtifacts.privateKeyPackage,
		extensions: [makeCordnGroupMetadataExtension(params.metadata)]
	});
}

export function getProtocolGroupId(state: { groupContext: { groupId: Uint8Array } }): string {
	return groupIdDecoder.decode(state.groupContext.groupId);
}

export function buildStoredChatGroup(params: {
	id: string;
	ownerPubkey?: string;
	coordinatorKey: string;
	createdAt?: number;
	stateBase64: string;
	metadata?: GroupMetadataInput;
	joinedWithKeyPackageRef?: string;
	joinEpoch?: bigint;
}): StoredChatGroup {
	return {
		id: params.id,
		ownerPubkey: params.ownerPubkey,
		coordinatorKey: params.coordinatorKey,
		createdAt: params.createdAt ?? Date.now(),
		stateBase64: params.stateBase64,
		lastCursor: 0,
		fetchCursor: 0,
		messages: [],
		syncIssues: [],
		metadata: params.metadata,
		joinedWithKeyPackageRef: params.joinedWithKeyPackageRef,
		joinEpoch: params.joinEpoch ?? 0n
	};
}

export async function acceptWelcomeToGroup(params: {
	welcome: WelcomeNotificationEntry;
	encodeState: (state: Awaited<ReturnType<typeof joinGroupFromWelcome>>) => string;
}): Promise<StoredChatGroup> {
	const keyPackageRecord = getChatKeyPackage(params.welcome.kpRef);
	if (!keyPackageRecord) {
		throw new Error(`Missing local key package for welcome ${params.welcome.kpRef}`);
	}

	const { keyPackage, privateKeyPackage } = decodeStoredKeyPackage(keyPackageRecord);
	const state = await joinGroupFromWelcome({
		welcomeBase64: params.welcome.welcomeBase64,
		keyPackage,
		privateKeyPackage
	});

	const metadata = getCordnGroupMetadataExtension(state) as GroupMetadataInput | undefined;
	const group = buildStoredChatGroup({
		id: getProtocolGroupId(state),
		coordinatorKey: params.welcome.coordinatorKey,
		stateBase64: params.encodeState(state),
		metadata,
		joinedWithKeyPackageRef: params.welcome.kpRef,
		joinEpoch: state.groupContext.epoch
	});
	return group;
}
