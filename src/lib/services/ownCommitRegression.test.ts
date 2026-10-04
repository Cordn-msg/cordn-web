/**
 * Regression suite for the report-05 bug class ("a rename nobody can read
 * past"): own-Commit adoption, self-echo recognition, and the IDB persistence
 * boundary. These tests assert the CORRECT behavior — on the unfixed code the
 * failure cases are red, which is the reproduction evidence; after the fixes
 * they are the permanent guard.
 *
 * The harness runs the REAL flows (ts-mls states, real seal crypto, real
 * ingest ladder, real pending-op matcher) with only the coordinator transport
 * and account edges stubbed. The storage layer is wrapped to enforce
 * IndexedDB's structured-clone semantics, which the in-memory backend hides.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
const carolPubkey = 'cd'.repeat(32);

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

let carolKeyPackage: Awaited<ReturnType<typeof makeKeyPackage>>;

// ---- fake coordinator: stores msg_64 verbatim like the real server ----------
let postCursor = 0;
let stored: Array<{ cursor: number; gid: string; msg_64: string; at: number }> = [];
// Test hook: inspect durable state at the moment a post is attempted.
let captureAtPost: (() => Promise<void>) | null = null;

const fakeClient = {
	async PostGroupMessage(input: { gid: string; msg_64: string }) {
		// Real server: decodeOpaqueMessageBase64 -> record -> encodeBase64 on
		// the way back out. Reproduce the codec round-trip exactly.
		const msg_64 = bytesToBase64(base64ToBytes(input.msg_64));
		const cursor = ++postCursor;
		stored.push({ cursor, gid: input.gid, msg_64, at: Math.floor(Date.now() / 1000) });
		await captureAtPost?.();
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
	},
	async ConsumeKeyPackage() {
		return {
			keyPackage: {
				pk: carolPubkey,
				kp_ref: 'kp-carol',
				event: { id: 'ev', sig: 'sig' } as never
			}
		};
	},
	async StoreWelcome() {
		return { ok: true };
	}
};

vi.mock('$app/environment', () => ({ browser: false }));

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

// The invite consumes carol's published key package; the publication-event
// parse is orthogonal to what is under test.
vi.mock('$lib/services/chatMlsUtils', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/chatMlsUtils')>();
	return {
		...actual,
		parseConsumedPublishedKeyPackage: vi.fn(async () => carolKeyPackage.publicPackage)
	};
});

// Real multi-device module except the network-facing seams (mirrors
// chatGroups.test.ts). isMultiDeviceActive stays real: no config = off.
vi.mock('$lib/services/multiDevice.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/multiDevice.svelte')>();
	return {
		...actual,
		reconcileTipForOutbound: vi.fn(async () => true),
		reconcileMultiDeviceNow: vi.fn(async () => ({
			status: 'off',
			counts: { seeded: 0, fastForwarded: 0, skipped: 0, dropped: 0, ignored: 0 }
		})),
		onGroupStateAdvance: vi.fn(),
		onMetaStateChange: vi.fn()
	};
});

// Key packages: real ts-mls generation, no coordinator publish.
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

// IndexedDB semantics: `put` structured-clones the record. Svelte $state
// proxies are not structured-cloneable — DataCloneError — which aborts the
// whole putGroup transaction in the browser. The memory backend spreads
// instead of cloning and would hide the leak, so wrap it.
const putAttempts: Array<{ ok: boolean; error?: string }> = [];
vi.mock('$lib/storage/chatStorage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/storage/chatStorage')>();
	const real = await actual.getChatStorage();
	return {
		...actual,
		getChatStorage: async () => {
			const storage = Object.create(real) as typeof real;
			storage.putGroup = async (group: Parameters<typeof real.putGroup>[0]) => {
				try {
					structuredClone(group);
					putAttempts.push({ ok: true });
				} catch (error) {
					putAttempts.push({ ok: false, error: String(error) });
					throw error; // IDB put() throws synchronously
				}
				return real.putGroup(group);
			};
			return storage;
		}
	};
});

import {
	createChatGroup,
	getChatGroup,
	updateChatGroupMetadata,
	ingestIncomingChatGroupMessages,
	listChatGroupSyncIssues,
	listChatGroupMessages,
	sendChatGroupMessage,
	inviteChatGroupMembers,
	persistGroup,
	reloadChatGroupsForOwner,
	repairSharedLeafRatchetDivergence,
	type StoredChatGroup
} from './chatGroups.svelte';
import { getChatStorage } from '$lib/storage/chatStorage';

function decodeEpoch(stateBase64: string): bigint {
	const decoded = clientStateDecoder(base64ToBytes(stateBase64), 0);
	if (!decoded) throw new Error('undecodable state');
	return decoded[0].groupContext.epoch;
}

async function deliverEcho(groupId: string) {
	const echo = stored[stored.length - 1];
	return ingestIncomingChatGroupMessages(groupId, [
		{ cursor: echo.cursor, createdAt: echo.at, opaqueMessageBase64: echo.msg_64 }
	]);
}

function issueDetails(groupId: string) {
	return listChatGroupSyncIssues(groupId).map((issue) => issue.detail);
}

beforeEach(async () => {
	postCursor = 0;
	stored = [];
	putAttempts.length = 0;
	captureAtPost = null;
	carolKeyPackage = await makeKeyPackage(carolPubkey);
});

describe('own-commit adoption (report-05 regression)', () => {
	test('happy path: the renamer adopts the new epoch and recognizes its own commit echo', async () => {
		const group = await createChatGroup({ name: 'e2e', coordinatorKey: 'ef'.repeat(32) });
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(0n);

		// rig: "Bob creates a group with Carol in it" — real add-member commit.
		const invite = await inviteChatGroupMembers({ groupId: group.id, identifiers: [carolPubkey] });
		expect(invite.failures, 'the invite must succeed').toEqual([]);
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n);

		// rig: "they exchange a message" before the rename (exercises the
		// adoptOwnCommitEvidence probe path over earlier messages).
		await sendChatGroupMessage({ groupId: group.id, content: 'hello' });

		await updateChatGroupMetadata({ groupId: group.id, name: 'e2e renamed' });

		// The renamer must have adopted the post-Commit state, and the durable
		// record must carry it plus the pending op for the self-echo match.
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64), 'adopt the new epoch').toBe(2n);
		const storage = await getChatStorage();
		const record = await storage.getGroup(group.id);
		expect(record?.pendingEpochOperations?.length ?? 0, 'op persisted').toBeGreaterThanOrEqual(1);
		expect(
			putAttempts.filter((attempt) => !attempt.ok),
			'all puts clone-clean'
		).toEqual([]);

		// Deliver the self-echo through the real ingest path (watch route).
		await deliverEcho(group.id);
		expect(issueDetails(group.id), 'no sync issues on the self-echo').toEqual([]);
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(2n);
	});

	test('bug 1: an ambiguous post must not strand the epoch — op + state durable before post', async () => {
		const group = await createChatGroup({ name: 'ambiguous', coordinatorKey: 'ef'.repeat(32) });
		await sendChatGroupMessage({ groupId: group.id, content: 'hello' });

		// Invariant under test: at the moment the Commit hits the wire, the
		// pending op and the adopted post-Commit state are already durable.
		const storage = await getChatStorage();
		let epochAtPost: bigint | undefined;
		let opsAtPost = 0;
		captureAtPost = async () => {
			const record = await storage.getGroup(group.id);
			epochAtPost = record ? decodeEpoch(bytesToBase64(record.stateBytes)) : undefined;
			opsAtPost = record?.pendingEpochOperations?.length ?? 0;
		};

		const originalPost = fakeClient.PostGroupMessage;
		fakeClient.PostGroupMessage = async (input) => {
			await originalPost(input); // server stores it...
			throw new Error('Request timed out'); // ...but the ack is lost
		};
		let flowError: unknown;
		try {
			await updateChatGroupMetadata({ groupId: group.id, name: 'renamed' });
		} catch (error) {
			flowError = error;
		} finally {
			fakeClient.PostGroupMessage = originalPost;
		}
		expect(String(flowError), 'the post failure still surfaces').toContain('timed out');

		// (a) durable record already carries the Commit's epoch + its op.
		expect(epochAtPost, 'adopted state must be durable before the post').toBe(1n);
		expect(opsAtPost, 'pending op must be durable before the post').toBeGreaterThanOrEqual(1);

		// (b) even a reload straight after the failed flow cannot lose them,
		// and the late self-echo is recognized instead of sibling-skipped.
		await reloadChatGroupsForOwner(account.pubkey);
		await deliverEcho(group.id);
		expect(issueDetails(group.id), 'no skip / no decrypt noise on the echo').toEqual([]);
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64), 'not deaf: epoch adopted').toBe(1n);
	});

	test('bug 2: a redelivered self-echo is permanently recognized as consumed', async () => {
		const group = await createChatGroup({ name: 'redelivery', coordinatorKey: 'ef'.repeat(32) });

		// Self-update Commit #1: synthesizes NO system message, so nothing records
		// its cursor as consumed — exactly the class where re-delivery bites.
		await repairSharedLeafRatchetDivergence(group.id, '0');
		const firstEcho = stored[stored.length - 1];
		const firstDelivery = {
			cursor: firstEcho.cursor,
			createdAt: firstEcho.at,
			opaqueMessageBase64: firstEcho.msg_64
		};
		await ingestIncomingChatGroupMessages(group.id, [firstDelivery]);
		expect(issueDetails(group.id), 'first delivery is clean').toEqual([]);

		// Commit #2 forces the pending-op reconcile that finalizes op #1
		await repairSharedLeafRatchetDivergence(group.id, '1');
		const secondEcho = stored[stored.length - 1];
		await ingestIncomingChatGroupMessages(group.id, [
			{
				cursor: secondEcho.cursor,
				createdAt: secondEcho.at,
				opaqueMessageBase64: secondEcho.msg_64
			}
		]);

		// a backlog/subscription race re-delivers echo #1: it must dedupe like
		// any already-consumed message instead of failing decryption
		await ingestIncomingChatGroupMessages(group.id, [firstDelivery]);
		expect(issueDetails(group.id), 'a re-delivered own commit must not fail decrypt').toEqual([]);
	});

	test('bug 3: records handed to storage must be structured-clone-clean (IDB put boundary)', async () => {
		const group = await createChatGroup({ name: 'idb', coordinatorKey: 'ef'.repeat(32) });
		putAttempts.length = 0;

		// Simulate the reactive store handing over $state-proxied nested fields
		// (what the browser store does): the storage boundary must unwrap them,
		// or the IDB transaction aborts wholesale (DataCloneError).
		persistGroup({
			...getChatGroup(group.id)!,
			branch: new Proxy({ kind: 'live', sinceEpoch: '0' }, {}) as StoredChatGroup['branch'],
			skippedSiblingCommit: new Proxy(
				{ epoch: '1', cursor: 3 },
				{}
			) as StoredChatGroup['skippedSiblingCommit']
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(
			putAttempts.filter((attempt) => !attempt.ok),
			'putGroup receives clone-clean data'
		).toEqual([]);
		const storage = await getChatStorage();
		const record = await storage.getGroup(group.id);
		expect(record, 'the write must actually land').toBeTruthy();
		expect(() => structuredClone(record)).not.toThrow();
	});

	test('bug 4: a failing StoreWelcome must not abort ingestion (wedge)', async () => {
		const group = await createChatGroup({ name: 'welcome', coordinatorKey: 'ef'.repeat(32) });
		const originalWelcome = fakeClient.StoreWelcome;
		fakeClient.StoreWelcome = async () => {
			throw new Error('key package expired'); // permanent rejection
		};
		let inviteResult: Awaited<ReturnType<typeof inviteChatGroupMembers>> | undefined;
		try {
			// Pre-fix the failing welcome aborts the whole sync and the invite
			// throws — nothing persists and the group is wedged forever.
			inviteResult = await inviteChatGroupMembers({
				groupId: group.id,
				identifiers: [carolPubkey]
			});
		} finally {
			fakeClient.StoreWelcome = originalWelcome;
		}
		expect(inviteResult?.failures, 'the invite survives the welcome failure').toEqual([]);
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n);

		// the op stays pending so a later sync can retry the welcome
		const storage = await getChatStorage();
		const record = await storage.getGroup(group.id);
		expect(record?.pendingEpochOperations?.length ?? 0).toBeGreaterThanOrEqual(1);

		// and the group is not wedged: a follow-up message still lands
		await sendChatGroupMessage({ groupId: group.id, content: 'still alive' });
		expect(
			listChatGroupMessages(group.id).some((message) => message.content === 'still alive')
		).toBe(true);
	});

	test('guard: a failed probe fetch in adoptOwnCommitEvidence does not break adoption', async () => {
		const group = await createChatGroup({ name: 'probe', coordinatorKey: 'ef'.repeat(32) });
		await inviteChatGroupMembers({ groupId: group.id, identifiers: [carolPubkey] });
		await sendChatGroupMessage({ groupId: group.id, content: 'hello' });

		const originalFetch = fakeClient.FetchManyGroupMessages;
		let failFetch = false;
		fakeClient.FetchManyGroupMessages = async (input) => {
			if (failFetch) throw new Error('coordinator unreachable');
			return originalFetch(input);
		};
		failFetch = true;
		try {
			await updateChatGroupMetadata({ groupId: group.id, name: 'renamed' });
		} finally {
			failFetch = false;
			fakeClient.FetchManyGroupMessages = originalFetch;
		}

		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(2n);
		const storage = await getChatStorage();
		const record = await storage.getGroup(group.id);
		expect(record?.pendingEpochOperations?.length ?? 0).toBe(1);
	});
});
