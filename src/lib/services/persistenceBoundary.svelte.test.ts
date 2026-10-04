/**
 * Browser-lane persistence boundary (report-05 class): this suite runs in
 * REAL Chromium, so `$state` store reads hand over REAL reactive proxies and
 * `putGroup` hits REAL IndexedDB — the exact conditions under which a proxy
 * leak aborts the whole putGroup transaction with DataCloneError and freezes
 * a group's history. The node harness (ownCommitRegression.test.ts) simulates
 * both with synthetic proxies; this suite proves the boundary under the real
 * ones, and guards the durable-epoch invariant across a real IDB reload.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { browser } from '$app/environment';
import {
	base64ToBytes,
	bytesToBase64,
	clientStateDecoder,
	encode,
	generateKeyPackage,
	keyPackageEncoder,
	privateKeyPackageEncoder
} from 'ts-mls';
import {
	createCordnMetadataCapabilities,
	createCredential,
	getCordnCipherSuite
} from '$lib/services/chatMlsUtils';

const account = { id: 'acc-1', pubkey: 'ab'.repeat(32) };

async function makeKeyPackage(pubkey: string) {
	const cipherSuite = await getCordnCipherSuite();
	const nowSeconds = Math.floor(Date.now() / 1000);
	return generateKeyPackage({
		credential: createCredential(pubkey),
		cipherSuite,
		capabilities: createCordnMetadataCapabilities(),
		lifetime: {
			notBefore: BigInt(nowSeconds - 86400),
			notAfter: BigInt(nowSeconds + 3153600000)
		}
	});
}

// ---- fake coordinator transport (msg_64 stored verbatim, as the server does)
let postCursor = 0;
let stored: Array<{ cursor: number; gid: string; msg_64: string; at: number }> = [];

const fakeClient = {
	async PostGroupMessage(input: { gid: string; msg_64: string }) {
		const msg_64 = bytesToBase64(base64ToBytes(input.msg_64));
		const cursor = ++postCursor;
		stored.push({ cursor, gid: input.gid, msg_64, at: Math.floor(Date.now() / 1000) });
		return { cursor, at: Math.floor(Date.now() / 1000), gid: input.gid };
	},
	async FetchManyGroupMessages(input: { groups: Array<{ gid: string; after?: number }> }) {
		const out: typeof stored = [];
		for (const req of input.groups) {
			for (const m of stored) {
				if (m.gid !== req.gid) continue;
				if (req.after !== undefined && m.cursor <= req.after) continue;
				out.push(m);
			}
		}
		return { messages: out };
	}
};

vi.mock('$lib/services/chatRuntime', () => ({
	assertCoordinatorOperationActive: vi.fn(),
	getCoordinatorClient: vi.fn(() => fakeClient),
	requireActiveAccount: vi.fn(() => account),
	withCoordinatorClient: vi.fn(
		(_a: unknown, _k: string, op: (c: typeof fakeClient) => Promise<unknown>) => op(fakeClient)
	),
	withCoordinatorClientRetry: vi.fn(
		(_a: unknown, _k: string, op: (c: typeof fakeClient) => Promise<unknown>) => op(fakeClient)
	)
}));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: {
		getActive: () => account,
		getAccount: () => account,
		active$: { subscribe: () => () => {} },
		accounts$: { subscribe: () => () => {} }
	},
	activeAccount: { subscribe: () => () => {} },
	logout: () => {}
}));

vi.mock('$lib/services/chatCoordinators.svelte', () => ({ markCoordinatorUsed: vi.fn() }));
vi.mock('$lib/services/chatWelcomeNotifications.svelte', () => ({
	getWelcomeNotification: vi.fn(),
	markWelcomeAccepted: vi.fn()
}));
vi.mock('$lib/services/chatJoinRequests.svelte', () => ({ removeSentJoinRequest: vi.fn() }));
vi.mock('$lib/services/chatGroupWatchStatus.svelte', () => ({
	isGroupActivelyWatched: vi.fn(() => true),
	isGroupFeedLive: vi.fn(() => true)
}));
vi.mock('$lib/services/nativeBridge', () => ({
	advanceNativeCursor: vi.fn(),
	groupFetchWatermark: vi.fn(() => 0)
}));
vi.mock('$lib/queries/chatKeyPackageQueries', () => ({
	fetchCoordinatorAvailableKeyPackages: vi.fn(async () => [])
}));
vi.mock('$lib/query-client', () => ({
	queryClient: {
		invalidateQueries: vi.fn(),
		removeQueries: vi.fn(),
		fetchQuery: vi.fn((opts: { queryFn: () => Promise<unknown> }) => opts.queryFn())
	}
}));
// Full manual stub, no importOriginal: the real multiDevice module imports
// chatGroups (circular), and importOriginal deadlocks the browser mocker.
// isMultiDeviceActive() === false matches the real "no config = off" behavior.
vi.mock('$lib/services/multiDevice.svelte', () => ({
	onGroupStateAdvance: vi.fn(),
	isMultiDeviceActive: vi.fn(() => false),
	reconcileMultiDeviceNow: vi.fn(async () => ({
		status: 'off',
		counts: { seeded: 0, fastForwarded: 0, skipped: 0, dropped: 0, ignored: 0 }
	})),
	reconcileTipForOutbound: vi.fn(async () => true),
	isGroupDocumentPullUnresolved: vi.fn(() => false)
}));
vi.mock('$lib/services/chatKeyPackages.svelte', () => ({
	createChatKeyPackage: vi.fn(async () => {
		const generated = await makeKeyPackage(account.pubkey);
		return {
			keyPackage: generated.publicPackage,
			privateKeyPackage: generated.privatePackage,
			record: {
				id: 'kp-1',
				ownerPubkey: account.pubkey,
				label: 'kp',
				isLastResort: false,
				keyPackageRef: 'kp-ref-1',
				keyPackageBase64: bytesToBase64(encode(keyPackageEncoder, generated.publicPackage)),
				privateKeyPackageBase64: bytesToBase64(
					encode(privateKeyPackageEncoder, generated.privatePackage)
				),
				cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
				createdAt: Date.now(),
				publishedCoordinatorKeys: []
			}
		};
	}),
	pruneZombieKeyPackages: vi.fn(async () => {}),
	getChatKeyPackage: vi.fn(),
	decodeStoredKeyPackage: vi.fn()
}));

import {
	createChatGroup,
	getChatGroup,
	replaceGroup,
	updateChatGroupMetadata,
	sendChatGroupMessage,
	ingestIncomingChatGroupMessages,
	listChatGroupMessages,
	listChatGroupSyncIssues,
	reloadChatGroupsForOwner
} from './chatGroups.svelte';
import { getChatStorage } from '$lib/storage/chatStorage';

function decodeEpoch(stateBase64: string): bigint {
	const decoded = clientStateDecoder(base64ToBytes(stateBase64), 0);
	if (!decoded) throw new Error('undecodable state');
	return decoded[0].groupContext.epoch;
}

beforeEach(() => {
	postCursor = 0;
	stored = [];
});

describe('persistence boundary (real $state proxies + real IndexedDB)', () => {
	test('store-proxied nested fields must survive a real IDB round trip', async () => {
		expect(browser, 'this suite must run in the browser lane').toBe(true);
		const group = await createChatGroup({ name: 'proxies', coordinatorKey: 'ef'.repeat(32) });

		// Populate nested fields THROUGH the reactive store, so the next read
		// hands back REAL $state proxies — the report's DataCloneError carriers.
		replaceGroup(group.id, {
			...getChatGroup(group.id)!,
			branch: { kind: 'live', sinceEpoch: '0' },
			skippedSiblingCommit: { epoch: '1', cursor: 3 }
		});

		// Re-read through the store and persist again: the spread now carries
		// PROXIED nested references straight into the storage boundary.
		replaceGroup(group.id, {
			...getChatGroup(group.id)!,
			syncIssues: [{ cursor: 9, createdAt: 1, detail: 'marker' }]
		});
		await reloadChatGroupsForOwner(account.pubkey); // flushes persistence

		const storage = await getChatStorage();
		const record = await storage.getGroup(group.id);
		expect(record, 'the write must land instead of aborting the IDB transaction').toBeTruthy();
		expect(
			record?.syncIssues.some((issue) => issue.detail === 'marker'),
			'the second write must not be lost to DataCloneError'
		).toBe(true);
		expect(record?.branch?.kind, 'proxied nested fields must round-trip').toBe('live');
		expect(record?.skippedSiblingCommit?.cursor).toBe(3);
	});

	test('rename survives reload and its self-echo is still recognized', async () => {
		const group = await createChatGroup({ name: 'reload', coordinatorKey: 'ef'.repeat(32) });
		await sendChatGroupMessage({ groupId: group.id, content: 'hello' });
		await updateChatGroupMetadata({ groupId: group.id, name: 'renamed in browser' });
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n);

		// the reload half of a page reload: store rebuilt from REAL IDB
		await reloadChatGroupsForOwner(account.pubkey);
		const reloaded = getChatGroup(group.id)!;
		expect(decodeEpoch(reloaded.stateBase64), 'adopted epoch must survive the reload').toBe(1n);
		expect(reloaded.metadata?.name).toBe('renamed in browser');
		expect(listChatGroupMessages(group.id).some((m) => m.content === 'hello')).toBe(true);

		// the self-echo must match the durable pending op, not sibling-skip
		const echo = stored[stored.length - 1];
		await ingestIncomingChatGroupMessages(group.id, [
			{ cursor: echo.cursor, createdAt: echo.at, opaqueMessageBase64: echo.msg_64 }
		]);
		expect(listChatGroupSyncIssues(group.id).map((i) => i.detail)).toEqual([]);
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n);
	});
});
