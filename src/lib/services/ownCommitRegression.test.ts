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
	privateKeyPackageEncoder,
	type ClientState
} from 'ts-mls';
import {
	createCordnMetadataCapabilities,
	createCredential,
	createSelfUpdateCommit,
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
const storeWelcomeCalls: Array<{ welcome_64: string; target_pk: string }> = [];

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
	async StoreWelcome(input: { welcome_64: string; target_pk: string }) {
		storeWelcomeCalls.push(input);
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
		isMultiDeviceActive: vi.fn(() => false),
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
	replaceGroup,
	reloadChatGroupsForOwner,
	repairSharedLeafRatchetDivergence,
	type StoredChatGroup
} from './chatGroups.svelte';
import {
	createApplicationMessageBase64,
	createUnsignedCordnMessageEvent,
	encodeAuthenticatedSender,
	staleGenerationLeafIndex,
	isSiblingCommitMessage
} from './chatGroupMessages.svelte';
import { joinGroupFromWelcome } from '$lib/services/chatMlsUtils';
import { isMultiDeviceActive } from '$lib/services/multiDevice.svelte';
import { getChatStorage } from '$lib/storage/chatStorage';
import { encryptGroupPayloadBase64 } from '$lib/services/chatGroupPayloadCrypto';
import { CoordinatorRejectedError } from '$lib/services/coordinatorClient';

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
	storeWelcomeCalls.length = 0;
	captureAtPost = null;
	vi.mocked(isMultiDeviceActive).mockReturnValue(false);
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

describe('behind-group guard and rejection rollback (report-05 amplifiers)', () => {
	test('bug 5: a group behind a skipped sibling commit must refuse sends and commits', async () => {
		const group = await createChatGroup({ name: 'behind', coordinatorKey: 'ef'.repeat(32) });
		// The skip path leaves this evidence on the record; without multi-device
		// there is no fast-forward that can heal it — staging from the stale
		// state is how forks and "kicked" members happen (spec §10).
		replaceGroup(group.id, {
			...getChatGroup(group.id)!,
			skippedSiblingCommit: { epoch: '0', cursor: 5 }
		});

		await expect(
			sendChatGroupMessage({ groupId: group.id, content: 'nope' })
		).rejects.toMatchObject({ name: 'GroupBehindSiblingError' });
		await expect(
			updateChatGroupMetadata({ groupId: group.id, name: 'nope' })
		).rejects.toMatchObject({ name: 'GroupBehindSiblingError' });
	});

	test('bug 6: a definitively rejected commit must roll the intent back', async () => {
		const group = await createChatGroup({ name: 'keep me', coordinatorKey: 'ef'.repeat(32) });
		const originalPost = fakeClient.PostGroupMessage;
		fakeClient.PostGroupMessage = async () => {
			// The coordinator answered with an error: the commit was NOT applied.
			throw new CoordinatorRejectedError('rate limited');
		};
		let flowError: unknown;
		try {
			await updateChatGroupMetadata({ groupId: group.id, name: 'renamed' });
		} catch (error) {
			flowError = error;
		} finally {
			fakeClient.PostGroupMessage = originalPost;
		}
		expect(String(flowError)).toContain('rate limited');

		// the intent rolls back: no ahead-of-stream state, no stranded op
		const after = getChatGroup(group.id)!;
		expect(decodeEpoch(after.stateBase64), 'state must roll back').toBe(0n);
		expect(after.metadata?.name, 'metadata must roll back').toBe('keep me');
		const storage = await getChatStorage();
		const record = await storage.getGroup(group.id);
		expect(record?.pendingEpochOperations?.length ?? 0, 'the op must be dropped').toBe(0);
	});
});

describe('sibling-commit detector (spec §10, cross-device)', () => {
	test('guard: a sibling commit is detected, recorded, and contains the damage', async () => {
		const group = await createChatGroup({ name: 'sibling', coordinatorKey: 'ef'.repeat(32) });

		// What a SECOND device of ours posts: a self-update Commit from the same
		// identity sealed at the shared epoch — this device has no pending op for
		// it, which is exactly the cross-device shape the skip detector keys on.
		const decoded = clientStateDecoder(base64ToBytes(getChatGroup(group.id)!.stateBase64), 0);
		const siblingState = decoded![0];
		const siblingCommit = await createSelfUpdateCommit({ state: siblingState });
		const { encryptedBase64 } = await encryptGroupPayloadBase64({
			state: siblingState,
			opaqueMessageBase64: siblingCommit.commitMessageBase64
		});
		await ingestIncomingChatGroupMessages(group.id, [
			{ cursor: 1, createdAt: Math.floor(Date.now() / 1000), opaqueMessageBase64: encryptedBase64 }
		]);

		// detection: the skip is recorded as fork evidence + a sync issue,
		// and the group neither self-removes nor poisons nor advances
		expect(
			issueDetails(group.id).some((detail) => detail.startsWith('Skipped sibling commit'))
		).toBe(true);
		expect(getChatGroup(group.id)?.skippedSiblingCommit).toBeTruthy();
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(0n);
		expect(getChatGroup(group.id)!.removedAtCursor).toBeUndefined();
		expect(getChatGroup(group.id)!.poisonedAtCursor).toBeUndefined();

		// containment: the stale state stages nothing (spec §10)
		await expect(
			sendChatGroupMessage({ groupId: group.id, content: 'nope' })
		).rejects.toMatchObject({ name: 'GroupBehindSiblingError' });
		await expect(
			updateChatGroupMetadata({ groupId: group.id, name: 'nope' })
		).rejects.toMatchObject({ name: 'GroupBehindSiblingError' });
	});
});

describe('ratchet-repair trigger discipline (fork-MR scenario I)', () => {
	// A generation chain from one state: message N seals generation N. ts-mls
	// retains the newest 10 generations (`retainKeysForGenerations`), so a
	// re-sent generation only fails once the chain has moved past the window —
	// the shape of a shared-leaf sibling whose ratchet replica is behind (own
	// leaf) or an account's two devices colliding (their leaf).
	async function craftGenerationChain(state: ClientState, pubkey: string, count: number) {
		const out: string[] = [];
		let current = state;
		for (let i = 0; i < count; i++) {
			const made = await createApplicationMessageBase64({
				state: current,
				event: createUnsignedCordnMessageEvent({
					pubkey,
					content: `gen-${i}`,
					kind: 9,
					tags: [],
					createdAt: Math.floor(Date.now() / 1000)
				}),
				authenticatedData: encodeAuthenticatedSender(pubkey)
			});
			const { encryptedBase64 } = await encryptGroupPayloadBase64({
				state,
				opaqueMessageBase64: made.opaqueMessageBase64
			});
			out.push(encryptedBase64);
			current = made.newState;
		}
		return out;
	}

	async function deliver(groupId: string, cursor: number, opaqueMessageBase64: string) {
		await ingestIncomingChatGroupMessages(groupId, [
			{ cursor, createdAt: Math.floor(Date.now() / 1000), opaqueMessageBase64 }
		]);
	}

	test('an own-leaf stale generation is attributed to our leaf and asks for the repair', async () => {
		vi.mocked(isMultiDeviceActive).mockReturnValue(true);
		const group = await createChatGroup({ name: 'repair', coordinatorKey: 'ef'.repeat(32) });
		const state = clientStateDecoder(base64ToBytes(getChatGroup(group.id)!.stateBase64), 0)![0];
		const chain = await craftGenerationChain(state, account.pubkey, 12);
		for (let i = 0; i < chain.length; i++) await deliver(group.id, i + 1, chain[i]);
		// the sibling's shape: generation 0 re-sent after the chain moved on
		await deliver(group.id, chain.length + 1, chain[0]);

		// the failure carries the sender leaf, and it is ours (creator = leaf 0)
		const stale = issueDetails(group.id).find((detail) =>
			detail.startsWith('Desired gen in the past')
		);
		expect(stale, 'the collision is recorded').toBeTruthy();
		expect(staleGenerationLeafIndex(stale!)).toBe(0);

		// the repair is scheduled: an epoch-advancing self-update commit lands
		await vi.waitFor(() => expect(postCursor).toBeGreaterThan(0), { timeout: 3000 });
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n);
	});

	test("another member's stale generation is recorded but never repaired here", async () => {
		vi.mocked(isMultiDeviceActive).mockReturnValue(true);
		const group = await createChatGroup({ name: 'no-repair', coordinatorKey: 'ef'.repeat(32) });
		await inviteChatGroupMembers({ groupId: group.id, identifiers: [carolPubkey] });
		await deliverEcho(group.id); // add commit confirmed → welcome stored
		const welcome = storeWelcomeCalls.at(-1)!;
		const carolState = await joinGroupFromWelcome({
			welcomeBase64: welcome.welcome_64,
			keyPackage: carolKeyPackage.publicPackage,
			privateKeyPackage: carolKeyPackage.privatePackage
		});
		const chain = await craftGenerationChain(carolState, carolPubkey, 12);
		for (let i = 0; i < chain.length; i++) await deliver(group.id, i + 2, chain[i]);
		const postsBefore = postCursor;
		// carol's own generation 0 re-sent: HER account's devices collided
		await deliver(group.id, chain.length + 2, chain[0]);

		// the collision is recorded and attributed — to CAROL's leaf, not ours
		const stale = issueDetails(group.id).find((detail) =>
			detail.startsWith('Desired gen in the past')
		);
		expect(stale, 'the collision is recorded').toBeTruthy();
		expect(staleGenerationLeafIndex(stale!)).toBeGreaterThan(0);

		// ...and nothing is repaired here: her two devices colliding is their
		// account's to settle (a repair from every member was 7 commits in 8
		// minutes in the live incident this guards)
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(postCursor, 'no repair commit').toBe(postsBefore);
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n); // unchanged
	});

	test('an unattributed stale-generation failure never asks for a repair', () => {
		expect(staleGenerationLeafIndex('Desired gen in the past')).toBeUndefined();
	});
});

describe('stale-epoch discipline (staircase StaleEpochTest)', () => {
	const garbage = () => bytesToBase64(new Uint8Array(64).fill(7));

	async function deliverPayload(groupId: string, cursor: number, opaqueMessageBase64: string) {
		await ingestIncomingChatGroupMessages(groupId, [
			{ cursor, createdAt: Math.floor(Date.now() / 1000), opaqueMessageBase64 }
		]);
	}

	async function craftReadableMessage(stateBase64: string, content: string) {
		const state = clientStateDecoder(base64ToBytes(stateBase64), 0)![0];
		const made = await createApplicationMessageBase64({
			state,
			event: createUnsignedCordnMessageEvent({
				pubkey: account.pubkey,
				content,
				kind: 9,
				tags: [],
				createdAt: Math.floor(Date.now() / 1000)
			}),
			authenticatedData: encodeAuthenticatedSender(account.pubkey)
		});
		const { encryptedBase64 } = await encryptGroupPayloadBase64({
			state,
			opaqueMessageBase64: made.opaqueMessageBase64
		});
		return encryptedBase64;
	}

	test('one unopenable payload refuses changes but not sends', async () => {
		const group = await createChatGroup({ name: 'stale', coordinatorKey: 'ef'.repeat(32) });
		await deliverPayload(group.id, 1, garbage());

		// a Commit staged from this view could split the group (seen live: an
		// approval from 10 epochs back) — refused
		await expect(
			updateChatGroupMetadata({ groupId: group.id, name: 'nope' })
		).rejects.toMatchObject({ name: 'GroupBehindSiblingError' });
		// one stray message must not block chat
		await sendChatGroupMessage({ groupId: group.id, content: 'still fine' });
		expect(listChatGroupMessages(group.id).some((m) => m.content === 'still fine')).toBe(true);
	});

	test('a run of two holds sends too, and a readable message clears it', async () => {
		const group = await createChatGroup({ name: 'stale2', coordinatorKey: 'ef'.repeat(32) });
		await deliverPayload(group.id, 1, garbage());
		await deliverPayload(group.id, 2, garbage());

		// two in a row: this device's sends would be unreadable noise — held
		await expect(
			sendChatGroupMessage({ groupId: group.id, content: 'nope' })
		).rejects.toMatchObject({ name: 'GroupBehindSiblingError' });
		expect(getChatGroup(group.id)!.staleMark?.unopenableCount).toBe(2);

		// a message sealed for our epoch proves we are on the group's line
		const readable = await craftReadableMessage(getChatGroup(group.id)!.stateBase64, 'readable');
		await deliverPayload(group.id, 3, readable);
		expect(getChatGroup(group.id)!.staleMark).toBeUndefined();

		// the mark is gone: commits work again
		await updateChatGroupMetadata({ groupId: group.id, name: 'back to normal' });
		expect(getChatGroup(group.id)!.metadata?.name).toBe('back to normal');
	});

	test('scenario E: a held payload keeps the cursor from passing it', async () => {
		vi.mocked(isMultiDeviceActive).mockReturnValue(true);
		const group = await createChatGroup({ name: 'floor', coordinatorKey: 'ef'.repeat(32) });
		const readable = await craftReadableMessage(getChatGroup(group.id)!.stateBase64, 'readable');
		// one batch: an unopenable payload @1 then a readable message @2
		await ingestIncomingChatGroupMessages(group.id, [
			{ cursor: 1, createdAt: Math.floor(Date.now() / 1000), opaqueMessageBase64: garbage() },
			{ cursor: 2, createdAt: Math.floor(Date.now() / 1000), opaqueMessageBase64: readable }
		]);

		// later messages may still be read in the same pass (and the readable one
		// proves we are on the group's line — the mark goes), but NO message may
		// carry fetchCursor past the held one: the coordinator never resends by
		// cursor, so passing it would make it unrecoverable
		expect(getChatGroup(group.id)!.fetchCursor).toBe(0);
		expect(listChatGroupMessages(group.id).some((m) => m.content === 'readable')).toBe(true);
		expect(getChatGroup(group.id)!.staleMark).toBeUndefined();
	});
});

describe('commit race and settlement (staircase RaceTest / OwnCommitTest)', () => {
	async function carolJoinsAGroup(name: string) {
		const group = await createChatGroup({ name, coordinatorKey: 'ef'.repeat(32) });
		await inviteChatGroupMembers({ groupId: group.id, identifiers: [carolPubkey] });
		await deliverEcho(group.id); // add commit confirmed → welcome stored
		const welcome = storeWelcomeCalls.at(-1)!;
		const carolState = await joinGroupFromWelcome({
			welcomeBase64: welcome.welcome_64,
			keyPackage: carolKeyPackage.publicPackage,
			privateKeyPackage: carolKeyPackage.privatePackage
		});
		return { group, carolState };
	}

	test('bug 8: a lost commit race rolls back and fails with CommitRaceLostError', async () => {
		const { group, carolState } = await carolJoinsAGroup('keep me');

		// carol's Commit from the SAME base epoch lands on the stream before
		// ours: the coordinator stored hers first and she won the race
		const carolCommit = await createSelfUpdateCommit({ state: carolState });
		const { encryptedBase64: carolSealed } = await encryptGroupPayloadBase64({
			state: carolState,
			opaqueMessageBase64: carolCommit.commitMessageBase64
		});
		// her Commit is stored BEFORE ours: postCursor moves so our post lands at
		// cursor 3 and hers at 2 (the coordinator stored hers first — she won)
		postCursor = 2;
		captureAtPost = async () => {
			const mine = stored[stored.length - 1];
			stored.push({
				cursor: 2,
				gid: mine.gid,
				msg_64: carolSealed,
				at: Math.floor(Date.now() / 1000)
			});
			stored.sort((a, b) => a.cursor - b.cursor);
		};

		await expect(
			updateChatGroupMetadata({ groupId: group.id, name: 'the rename' })
		).rejects.toMatchObject({ name: 'CommitRaceLostError' });
		captureAtPost = null;

		// the change did not happen; the winner's did — and this device is on it
		const settled = getChatGroup(group.id)!;
		expect(settled.metadata?.name).toBe('keep me');
		expect(decodeEpoch(settled.stateBase64)).toBe(2n); // carol's commit applied
		expect(
			listChatGroupMessages(group.id).some((m) => m.content.includes('"systemKind":"commit-lost"')),
			'the chat says the edit did not happen'
		).toBe(true);
		expect(settled.skippedSiblingCommit).toBeUndefined(); // never a sibling's
		const record = await (await getChatStorage()).getGroup(group.id);
		expect(record?.pendingEpochOperations?.every((op) => op.status === 'lost')).toBe(true);

		// ...and the operation is retryable on the winner's state
		await updateChatGroupMetadata({ groupId: group.id, name: 'retried' });
		expect(getChatGroup(group.id)!.metadata?.name).toBe('retried');
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(3n);
	});

	test('bug 9: a commit that never landed settles as lost and the next one proceeds', async () => {
		const group = await createChatGroup({ name: 'keep me', coordinatorKey: 'ef'.repeat(32) });
		const originalPost = fakeClient.PostGroupMessage;
		fakeClient.PostGroupMessage = async () => {
			throw new Error('network down'); // ambiguous: not a coordinator rejection
		};
		try {
			await expect(updateChatGroupMetadata({ groupId: group.id, name: 'first' })).rejects.toThrow(
				'network down'
			);
		} finally {
			fakeClient.PostGroupMessage = originalPost;
		}
		// adopt-early kept the intent (its fate was unknown)
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n);

		// the next commit settles it: the confirm fetch shows the bytes never
		// landed → lost + rolled back → the second proceeds on the old epoch
		await updateChatGroupMetadata({ groupId: group.id, name: 'second' });
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n);
		expect(getChatGroup(group.id)!.metadata?.name).toBe('second');
		expect(
			listChatGroupMessages(group.id).some((m) => m.content.includes('"systemKind":"commit-lost"'))
		).toBe(true);
	});

	test('bug 10: an unsettled commit blocks the next one (CommitUnconfirmedError)', async () => {
		const group = await createChatGroup({ name: 'keep me', coordinatorKey: 'ef'.repeat(32) });
		const originalPost = fakeClient.PostGroupMessage;
		fakeClient.PostGroupMessage = async () => {
			throw new Error('network down');
		};
		try {
			await expect(updateChatGroupMetadata({ groupId: group.id, name: 'first' })).rejects.toThrow(
				'network down'
			);
		} finally {
			fakeClient.PostGroupMessage = originalPost;
		}

		// the settlement can learn nothing (the confirm fetch fails too) — wait
		// instead of staging a second Commit on a phantom epoch
		const originalFetch = fakeClient.FetchManyGroupMessages;
		fakeClient.FetchManyGroupMessages = async () => {
			throw new Error('coordinator unreachable');
		};
		try {
			await expect(
				updateChatGroupMetadata({ groupId: group.id, name: 'second' })
			).rejects.toMatchObject({ name: 'CommitUnconfirmedError' });
		} finally {
			fakeClient.FetchManyGroupMessages = originalFetch;
		}
		// the intent survives for its echo
		const record = await (await getChatStorage()).getGroup(group.id);
		expect(record?.pendingEpochOperations?.some((op) => op.status !== 'lost')).toBe(true);
	});
});

describe('former-epoch keys (report-05 disappearing messages)', () => {
	const garbage = () => bytesToBase64(new Uint8Array(64).fill(7));

	async function deliverPayload(groupId: string, cursor: number, opaqueMessageBase64: string) {
		await ingestIncomingChatGroupMessages(groupId, [
			{ cursor, createdAt: Math.floor(Date.now() / 1000), opaqueMessageBase64 }
		]);
	}

	async function craftReadableMessage(stateBase64: string, content: string) {
		const state = clientStateDecoder(base64ToBytes(stateBase64), 0)![0];
		const made = await createApplicationMessageBase64({
			state,
			event: createUnsignedCordnMessageEvent({
				pubkey: account.pubkey,
				content,
				kind: 9,
				tags: [],
				createdAt: Math.floor(Date.now() / 1000)
			}),
			authenticatedData: encodeAuthenticatedSender(account.pubkey)
		});
		const { encryptedBase64 } = await encryptGroupPayloadBase64({
			state,
			opaqueMessageBase64: made.opaqueMessageBase64
		});
		return encryptedBase64;
	}

	test('bug 11: a message sealed at the pre-commit epoch is not lost', async () => {
		const group = await createChatGroup({ name: 'formers', coordinatorKey: 'ef'.repeat(32) });
		// sealed at epoch 0 by a sender who had not seen our rename yet
		const lagging = await craftReadableMessage(getChatGroup(group.id)!.stateBase64, 'lagging');
		await updateChatGroupMetadata({ groupId: group.id, name: 'renamed' });
		expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(1n);

		// it slips in on the stream BEFORE our commit's echo — report-05's
		// "disappearing messages": pre-fix the outer seal fails at the new epoch
		// and the message is gone for good
		await deliverPayload(group.id, 2, lagging);
		expect(listChatGroupMessages(group.id).some((m) => m.content === 'lagging')).toBe(true);
		expect(getChatGroup(group.id)!.staleMark).toBeUndefined(); // it opened
	});

	test('bug 11b: a former-epoch decrypt is not liveness and keeps the mark', async () => {
		const group = await createChatGroup({ name: 'formers2', coordinatorKey: 'ef'.repeat(32) });
		const lagging = await craftReadableMessage(getChatGroup(group.id)!.stateBase64, 'lagging');
		await updateChatGroupMetadata({ groupId: group.id, name: 'renamed' });

		await deliverPayload(group.id, 2, garbage());
		expect(getChatGroup(group.id)!.staleMark).toBeTruthy();

		// the lagging message opens with a retained former-epoch key — but a
		// message sealed for OUR epoch is the only thing that proves this device
		// is on the group's line (staircase: formerEpoch is not liveness)
		await deliverPayload(group.id, 3, lagging);
		expect(getChatGroup(group.id)!.staleMark).toBeTruthy();

		const current = await craftReadableMessage(getChatGroup(group.id)!.stateBase64, 'current');
		await deliverPayload(group.id, 4, current);
		expect(getChatGroup(group.id)!.staleMark).toBeUndefined();
	});
});

test('bug 12 (fork-MR scenario K): a key package for another identity is refused', async () => {
	const group = await createChatGroup({ name: 'readd', coordinatorKey: 'ef'.repeat(32) });
	const kpQueries = await import('$lib/queries/chatKeyPackageQueries');
	// the listing names carol's slot…
	vi.mocked(kpQueries.fetchCoordinatorAvailableKeyPackages).mockResolvedValueOnce([
		{ pk: carolPubkey, kp_ref: 'kp-carol', last_resort: false, at: 1 }
	] as never);
	const original = fakeClient.ConsumeKeyPackage;
	// …but the coordinator hands out ANOTHER identity's package for it (the
	// re-add case: a stale/orphaned package from before a reinstall)
	fakeClient.ConsumeKeyPackage = async () => ({
		keyPackage: {
			pk: 'ee'.repeat(32),
			kp_ref: 'kp-stranger',
			event: { id: 'ev', sig: 'sig' } as never
		}
	});
	let result: Awaited<ReturnType<typeof inviteChatGroupMembers>> | undefined;
	try {
		result = await inviteChatGroupMembers({ groupId: group.id, identifiers: [carolPubkey] });
	} finally {
		fakeClient.ConsumeKeyPackage = original;
	}
	// refused — never added under the requested name
	expect(result?.failures).toHaveLength(1);
	expect(result?.failures[0].error).toContain('different identity');
	expect(decodeEpoch(getChatGroup(group.id)!.stateBase64)).toBe(0n); // nothing committed
});

describe('sibling-commit rule (spec multi-device §10, named predicate)', () => {
	test('a Commit from our own shared leaf is the sibling; everything else is not', () => {
		expect(
			isSiblingCommitMessage({
				kind: 'commit',
				senderStablePubkey: 'a'.repeat(64),
				localStablePubkey: 'A'.repeat(64)
			})
		).toBe(true);
		// another member's commit
		expect(
			isSiblingCommitMessage({
				kind: 'commit',
				senderStablePubkey: 'b'.repeat(64),
				localStablePubkey: 'a'.repeat(64)
			})
		).toBe(false);
		// an application message is never a sibling commit
		expect(
			isSiblingCommitMessage({
				kind: 'application',
				senderStablePubkey: 'a'.repeat(64),
				localStablePubkey: 'a'.repeat(64)
			})
		).toBe(false);
		// unattributed (no local identity): never skipped
		expect(
			isSiblingCommitMessage({
				kind: 'commit',
				senderStablePubkey: 'a'.repeat(64),
				localStablePubkey: undefined
			})
		).toBe(false);
	});
});
