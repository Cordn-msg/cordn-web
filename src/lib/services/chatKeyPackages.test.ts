import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	CoordinatorReadBackoffError,
	isCoordinatorReadBackoffError
} from './coordinatorHealth.svelte';
import type { StoredKeyPackageRecord } from './chatKeyPackages.svelte';

const withCoordinatorClientMock = vi.fn(
	<T>(_account: unknown, _coordinatorKey: string, operation: (client: T) => Promise<unknown>) =>
		operation({ RemoveKeyPackages: vi.fn().mockResolvedValue({}) } as unknown as T)
);
const publishKeyPackageMock = vi.fn().mockResolvedValue({ last_resort: true });
const withCoordinatorClientRetryMock = vi.fn(
	<T>(_account: unknown, _coordinatorKey: string, operation: (client: T) => Promise<unknown>) =>
		operation({ PublishKeyPackage: publishKeyPackageMock } as unknown as T)
);
const requireActiveAccountMock = vi.fn(() => ({ pubkey: 'aa'.repeat(32) }));
const fetchQueryMock = vi.fn();
const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const getQueryDataMock = vi.fn();
const markCoordinatorUsedMock = vi.fn();
const listKnownCoordinatorKeysMock = vi.fn((): string[] => []);
const keyPackageDecoderMock = vi.fn();
const privateKeyPackageDecoderMock = vi.fn();
const makeKeyPackageRefMock = vi.fn();

vi.mock('ts-mls', async () => {
	const actual = await vi.importActual<typeof import('ts-mls')>('ts-mls');
	return {
		...actual,
		keyPackageDecoder: keyPackageDecoderMock,
		privateKeyPackageDecoder: privateKeyPackageDecoderMock,
		makeKeyPackageRef: makeKeyPackageRefMock
	};
});

vi.mock('$app/environment', () => ({ browser: false }));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { getActive: () => ({ pubkey: 'aa'.repeat(32) }) }
}));

vi.mock('$lib/services/chatRuntime', () => ({
	requireActiveAccount: requireActiveAccountMock,
	withCoordinatorClient: withCoordinatorClientMock,
	withCoordinatorClientRetry: withCoordinatorClientRetryMock
}));

vi.mock('$lib/services/chatCoordinators.svelte', () => ({
	markCoordinatorUsed: markCoordinatorUsedMock,
	listKnownCoordinatorKeys: listKnownCoordinatorKeysMock,
	getCoordinatorLabel: vi.fn((key: string) => `Coordinator ${key.slice(0, 8)}`)
}));

vi.mock('$lib/services/chatWelcomeNotifications.svelte', () => ({
	listKnownCoordinatorKeys: vi.fn(() => [])
}));

vi.mock('$lib/query-client', () => ({
	queryClient: {
		fetchQuery: fetchQueryMock,
		invalidateQueries: invalidateQueriesMock,
		getQueryData: getQueryDataMock
	}
}));

vi.mock('$lib/queries/chatKeyPackageQueries', () => ({
	fetchCoordinatorAvailableKeyPackages: vi.fn()
}));

vi.mock('$lib/services/chatMlsUtils', () => ({
	CLI_CIPHERSUITE: 1,
	createCordnMetadataCapabilities: vi.fn(),
	createCredential: vi.fn(),
	ensureLastResortKeyPackageExtension: vi.fn(),
	isLastResortKeyPackage: vi.fn(),
	getCordnCipherSuite: vi.fn(() => 1)
}));

vi.mock('$lib/services/chatStorage', () => ({
	getChatStorage: vi.fn().mockResolvedValue({
		putKeyPackages: vi.fn().mockResolvedValue(undefined),
		listKeyPackages: vi.fn().mockResolvedValue([]),
		deleteKeyPackagesByOwner: vi.fn().mockResolvedValue(undefined)
	})
}));

const OWNER = 'aa'.repeat(32);
const COORD_A = 'bb'.repeat(32);
const COORD_B = 'cc'.repeat(32);

function makeRecord(
	ref: string,
	coordinators: string[],
	overrides: Partial<StoredKeyPackageRecord> = {}
): StoredKeyPackageRecord {
	return {
		id: ref,
		ownerPubkey: OWNER,
		label: ref,
		isLastResort: false,
		keyPackageRef: ref,
		keyPackageBase64: 'AA==',
		privateKeyPackageBase64: 'AA==',
		cipherSuite: '1',
		createdAt: 1,
		publishedCoordinatorKeys: coordinators,
		...overrides
	} as StoredKeyPackageRecord;
}

describe('purgeCoordinatorKeyPackages()', () => {
	beforeEach(() => {
		withCoordinatorClientMock.mockClear();
		invalidateQueriesMock.mockClear();
		fetchQueryMock.mockResolvedValue([]);
	});

	test('removes the coordinator from publish lists and drops only passed deleteRefs', async () => {
		const { chatKeyPackagesStore, purgeCoordinatorKeyPackages } =
			await import('./chatKeyPackages.svelte');

		// reconcile() re-derives publishedCoordinatorKeys from coordinator truth:
		// report kp-shared still available on COORD_B so it survives the sweep.
		fetchQueryMock.mockImplementation((opts: { queryKey: string[] }) => {
			const coordinatorKey = opts.queryKey[opts.queryKey.length - 2];
			return coordinatorKey === COORD_B
				? Promise.resolve([{ pk: OWNER, kp_ref: 'kp-shared' }])
				: Promise.resolve([]);
		});

		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-only-a', [COORD_A]),
			makeRecord('kp-shared', [COORD_A, COORD_B]),
			makeRecord('kp-other', [COORD_B])
		];

		await purgeCoordinatorKeyPackages(COORD_A, ['kp-only-a']);

		const refs = chatKeyPackagesStore.keyPackages.map((entry) => entry.keyPackageRef);
		expect(refs.sort()).toEqual(['kp-other', 'kp-shared']);
		for (const entry of chatKeyPackagesStore.keyPackages) {
			expect(entry.publishedCoordinatorKeys).not.toContain(COORD_A);
		}
		expect(
			chatKeyPackagesStore.keyPackages.find((e) => e.keyPackageRef === 'kp-shared')!
				.publishedCoordinatorKeys
		).toEqual([COORD_B]);
	});

	test('does not drop publish-orphan records when not in deleteRefs (scoped, not global)', async () => {
		const { chatKeyPackagesStore, purgeCoordinatorKeyPackages } =
			await import('./chatKeyPackages.svelte');

		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-only-a', [COORD_A]),
			makeRecord('kp-other', [COORD_B])
		];

		await purgeCoordinatorKeyPackages(COORD_A, []);

		// kp-only-a is now a publish-orphan (empty list) but was NOT passed as a
		// consumed ref, so it must survive the scoped purge.
		const orphan = chatKeyPackagesStore.keyPackages.find((e) => e.keyPackageRef === 'kp-only-a');
		expect(orphan).toBeDefined();
		expect(orphan!.publishedCoordinatorKeys).toEqual([]);
	});
});

describe('removeChatKeyPackage()', () => {
	beforeEach(() => {
		withCoordinatorClientMock.mockReset();
		withCoordinatorClientMock.mockImplementation(
			<T>(_account: unknown, _coordinatorKey: string, operation: (client: T) => Promise<unknown>) =>
				operation({ RemoveKeyPackages: vi.fn().mockResolvedValue({}) } as unknown as T)
		);
		invalidateQueriesMock.mockClear();
		getQueryDataMock.mockReset();
	});

	test('is idempotent when the coordinator no longer has the key package', async () => {
		const { chatKeyPackagesStore, removeChatKeyPackage } = await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [makeRecord('kp-a', [COORD_A, COORD_B])];
		withCoordinatorClientMock.mockRejectedValue(
			new Error('key package not found') // unrecognized "missing" phrasing
		);

		await expect(removeChatKeyPackage('kp-a')).resolves.toBeUndefined();

		// Both coordinators attempted, neither error aborts the rest.
		expect(withCoordinatorClientMock).toHaveBeenCalledTimes(2);
		expect(chatKeyPackagesStore.keyPackages).toHaveLength(0);
		expect(invalidateQueriesMock).toHaveBeenCalled();
	});

	test('skips the RPC for coordinators whose cached list already lacks the ref', async () => {
		const { chatKeyPackagesStore, removeChatKeyPackage } = await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [makeRecord('kp-a', [COORD_A, COORD_B])];
		getQueryDataMock.mockImplementation((queryKey: readonly string[]) => {
			const coordinatorKey = queryKey[queryKey.length - 2];
			// COORD_A queried and kp-a absent; COORD_B never queried.
			return coordinatorKey === COORD_A ? [{ kp_ref: 'kp-other' }] : undefined;
		});

		await removeChatKeyPackage('kp-a');

		// COORD_A skipped via cache; only COORD_B gets the RPC.
		expect(withCoordinatorClientMock).toHaveBeenCalledTimes(1);
		expect(chatKeyPackagesStore.keyPackages).toHaveLength(0);
	});
});

describe('listZombieKeyPackageRefs()', () => {
	test('consumed + stale-marker KPs are zombies only when remotely absent, never last-resorts', async () => {
		const { chatKeyPackagesStore, listZombieKeyPackageRefs } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-a', [COORD_A]),
			{ ...makeRecord('kp-b', [COORD_A]), isLastResort: true },
			makeRecord('kp-c', [COORD_A])
		];
		const consumedRefs = ['kp-a', 'kp-b', 'kp-c'];

		// Without remote data: marked-published KPs are kept (conservative).
		expect(listZombieKeyPackageRefs(consumedRefs)).toEqual([]);

		// With verified remote absence: consumed non-last-resorts are prunable;
		// the last-resort stays exempt.
		const remoteAbsentRefs = new Set(['kp-a', 'kp-b', 'kp-c']);
		expect(listZombieKeyPackageRefs(consumedRefs, { remoteAbsentRefs })).toEqual(['kp-a', 'kp-c']);
	});
});

describe('read-backoff breaker error identity', () => {
	test('matches only the thrown class, not lookalike messages', () => {
		expect(isCoordinatorReadBackoffError(new CoordinatorReadBackoffError())).toBe(true);
		expect(
			isCoordinatorReadBackoffError(
				new Error('Coordinator unreachable (recent failure; retrying soon)')
			)
		).toBe(false);
	});
});

describe('reconcilePublishedKeyPackagesForActiveAccount()', () => {
	beforeEach(() => {
		fetchQueryMock.mockReset();
		fetchQueryMock.mockResolvedValue([]);
	});

	test('keeps publish markers for coordinators that could not be verified', async () => {
		const { chatKeyPackagesStore, reconcilePublishedKeyPackagesForActiveAccount } =
			await import('./chatKeyPackages.svelte');

		// COORD_A unreachable, COORD_B healthy and holding kp-b.
		fetchQueryMock.mockImplementation((opts: { queryKey: string[] }) => {
			const coordinatorKey = opts.queryKey[opts.queryKey.length - 2];
			return coordinatorKey === COORD_A
				? Promise.reject(new Error('coordinator offline'))
				: Promise.resolve([{ pk: OWNER, kp_ref: 'kp-b' }]);
		});

		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-a', [COORD_A]),
			makeRecord('kp-b', [COORD_B])
		];

		await reconcilePublishedKeyPackagesForActiveAccount();

		// Unverifiable ≠ unpublished: A's marker stays; B's verified marker stays.
		expect(
			chatKeyPackagesStore.keyPackages.find((e) => e.keyPackageRef === 'kp-a')!
				.publishedCoordinatorKeys
		).toEqual([COORD_A]);
		expect(
			chatKeyPackagesStore.keyPackages.find((e) => e.keyPackageRef === 'kp-b')!
				.publishedCoordinatorKeys
		).toEqual([COORD_B]);
	});

	test('drops markers verified absent by a healthy coordinator', async () => {
		const { chatKeyPackagesStore, reconcilePublishedKeyPackagesForActiveAccount } =
			await import('./chatKeyPackages.svelte');

		fetchQueryMock.mockResolvedValue([{ pk: OWNER, kp_ref: 'other' }]);
		chatKeyPackagesStore.keyPackages = [makeRecord('kp-a', [COORD_B])];

		await reconcilePublishedKeyPackagesForActiveAccount();

		expect(
			chatKeyPackagesStore.keyPackages.find((e) => e.keyPackageRef === 'kp-a')!
				.publishedCoordinatorKeys
		).toEqual([]);
	});
});

describe('getLastResortKeyPackageEntry() pick (spec §11.5)', () => {
	beforeEach(async () => {
		const { chatKeyPackagesStore } = await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [];
	});

	test('prefers a published record over a newer unpublished mint', async () => {
		const { chatKeyPackagesStore, getLastResortKeyPackageEntry } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-new', [], { isLastResort: true, createdAt: 300, keyPackageBase64: 'kp-new' }),
			makeRecord('kp-published', [COORD_A], {
				isLastResort: true,
				createdAt: 100,
				keyPackageBase64: 'kp-published'
			})
		];
		// The published record is the invite surface; a local-only mint must
		// never displace it in the meta document.
		expect(getLastResortKeyPackageEntry()?.keyPackage).toBe('kp-published');
	});

	test('newest mint wins among published records', async () => {
		const { chatKeyPackagesStore, getLastResortKeyPackageEntry } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-old', [COORD_A], {
				isLastResort: true,
				createdAt: 100,
				keyPackageBase64: 'kp-old'
			}),
			makeRecord('kp-new', [COORD_B], {
				isLastResort: true,
				createdAt: 200,
				keyPackageBase64: 'kp-new'
			})
		];
		expect(getLastResortKeyPackageEntry()?.keyPackage).toBe('kp-new');
	});

	test('falls back to an unpublished record when it is the only one', async () => {
		const { chatKeyPackagesStore, getLastResortKeyPackageEntry } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-only', [], { isLastResort: true, createdAt: 100, keyPackageBase64: 'kp-only' })
		];
		expect(getLastResortKeyPackageEntry()?.keyPackage).toBe('kp-only');
	});

	test('undefined when the account holds no last-resort', async () => {
		const { chatKeyPackagesStore, getLastResortKeyPackageEntry } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [makeRecord('kp-consumable', [COORD_A])];
		expect(getLastResortKeyPackageEntry()).toBeUndefined();
	});
});

describe('loadLastResortKeyPackage() adoption (spec §11.5)', () => {
	beforeEach(() => {
		keyPackageDecoderMock.mockReset();
		privateKeyPackageDecoderMock.mockReset();
		makeKeyPackageRefMock.mockReset();
	});

	test('derives createdAt from the key package mint time, not adoption time', async () => {
		const { chatKeyPackagesStore, loadLastResortKeyPackage } =
			await import('./chatKeyPackages.svelte');
		keyPackageDecoderMock.mockReturnValue([
			{ leafNode: { lifetime: { notBefore: 1_700_000_000n } } },
			0
		]);
		privateKeyPackageDecoderMock.mockReturnValue([{}, 0]);
		makeKeyPackageRefMock.mockResolvedValue(new Uint8Array([1, 2, 3]));

		chatKeyPackagesStore.keyPackages = [];
		const loaded = await loadLastResortKeyPackage({
			keyPackage: 'AA==',
			privateKeyPackage: 'AA==',
			coordinators: [COORD_A]
		});

		expect(loaded).toBe(true);
		expect(chatKeyPackagesStore.keyPackages).toHaveLength(1);
		const record = chatKeyPackagesStore.keyPackages[0];
		// Mint time rides inside the authenticated bytes (notBefore, seconds);
		// adoption must not reorder the canonical-pick tie-break via Date.now().
		expect(record.createdAt).toBe(1_700_000_000_000);
		expect(record.publishedCoordinatorKeys).toEqual([COORD_A]);
		expect(record.isLastResort).toBe(true);
	});

	test('idempotent by ref: a held package is not re-added', async () => {
		const { chatKeyPackagesStore, loadLastResortKeyPackage } =
			await import('./chatKeyPackages.svelte');
		keyPackageDecoderMock.mockReturnValue([
			{ leafNode: { lifetime: { notBefore: 1_700_000_000n } } },
			0
		]);
		privateKeyPackageDecoderMock.mockReturnValue([{}, 0]);
		makeKeyPackageRefMock.mockResolvedValue(new Uint8Array([1, 2, 3]));

		chatKeyPackagesStore.keyPackages = [];
		const entry = { keyPackage: 'AA==', privateKeyPackage: 'AA==', coordinators: [COORD_A] };
		expect(await loadLastResortKeyPackage(entry)).toBe(true);
		expect(await loadLastResortKeyPackage(entry)).toBe(false);
		expect(chatKeyPackagesStore.keyPackages).toHaveLength(1);
	});
});

describe('repairLastResortAlignment() (spec §11.5 resolution order)', () => {
	beforeEach(() => {
		fetchQueryMock.mockReset();
		invalidateQueriesMock.mockClear();
		markCoordinatorUsedMock.mockClear();
		withCoordinatorClientRetryMock.mockClear();
		publishKeyPackageMock.mockClear();
		listKnownCoordinatorKeysMock.mockReturnValue([COORD_A]);
	});

	test('foreign served entry → publishes the pick over it (the reported incident)', async () => {
		const { chatKeyPackagesStore, repairLastResortAlignment } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-pick', [COORD_A], {
				isLastResort: true,
				createdAt: 200,
				keyPackageBase64: 'kp-pick'
			})
		];
		fetchQueryMock.mockImplementation((opts: { queryKey: string[] }) => {
			const coordinatorKey = opts.queryKey[opts.queryKey.length - 2];
			return Promise.resolve(
				coordinatorKey === COORD_A
					? [{ pk: OWNER, kp_ref: 'kp-foreign', last_resort: true, at: 1 }]
					: []
			);
		});

		await repairLastResortAlignment();

		// One publish, of the fleet-held pick, to the diverged coordinator.
		expect(withCoordinatorClientRetryMock).toHaveBeenCalledTimes(1);
		expect(withCoordinatorClientRetryMock.mock.calls[0][1]).toBe(COORD_A);
		expect(publishKeyPackageMock).toHaveBeenCalledWith({
			kp_ref: 'kp-pick',
			kp_64: 'kp-pick'
		});
		// The marker survives the round trip (reconcile pruned it, publish restored it).
		expect(
			chatKeyPackagesStore.keyPackages.find((e) => e.keyPackageRef === 'kp-pick')!
				.publishedCoordinatorKeys
		).toContain(COORD_A);
	});

	test('held-but-not-pick served entry → re-adopts it as canonical, zero coordinator writes', async () => {
		const { chatKeyPackagesStore, repairLastResortAlignment, getLastResortKeyPackageEntry } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-new', [], { isLastResort: true, createdAt: 200, keyPackageBase64: 'kp-new' }),
			makeRecord('kp-old', [], { isLastResort: true, createdAt: 100, keyPackageBase64: 'kp-old' })
		];
		fetchQueryMock.mockImplementation((opts: { queryKey: string[] }) => {
			const coordinatorKey = opts.queryKey[opts.queryKey.length - 2];
			return Promise.resolve(
				coordinatorKey === COORD_A
					? [{ pk: OWNER, kp_ref: 'kp-old', last_resort: true, at: 1 }]
					: []
			);
		});

		await repairLastResortAlignment();

		// The coordinator's entry is held locally → restoring its claim flips the
		// pick to it (published beats unpublished); no PublishKeyPackage needed.
		expect(withCoordinatorClientRetryMock).not.toHaveBeenCalled();
		expect(getLastResortKeyPackageEntry()?.keyPackage).toBe('kp-old');
		expect(
			chatKeyPackagesStore.keyPackages.find((e) => e.keyPackageRef === 'kp-old')!
				.publishedCoordinatorKeys
		).toContain(COORD_A);
	});

	test('serves the pick → steady-state no-op', async () => {
		const { chatKeyPackagesStore, repairLastResortAlignment } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-pick', [COORD_A], {
				isLastResort: true,
				createdAt: 200,
				keyPackageBase64: 'kp-pick'
			})
		];
		fetchQueryMock.mockImplementation((opts: { queryKey: string[] }) => {
			const coordinatorKey = opts.queryKey[opts.queryKey.length - 2];
			return Promise.resolve(
				coordinatorKey === COORD_A
					? [{ pk: OWNER, kp_ref: 'kp-pick', last_resort: true, at: 1 }]
					: []
			);
		});

		await repairLastResortAlignment();

		expect(withCoordinatorClientRetryMock).not.toHaveBeenCalled();
		expect(markCoordinatorUsedMock).not.toHaveBeenCalled();
	});

	test('empty coordinators: no publish — publish claims pruned by reconcile stay demand-driven', async () => {
		const { chatKeyPackagesStore, repairLastResortAlignment } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-pick', [COORD_A], {
				isLastResort: true,
				createdAt: 200,
				keyPackageBase64: 'kp-pick'
			})
		];
		listKnownCoordinatorKeysMock.mockReturnValue([COORD_A, COORD_B]);
		// Both coordinators verified to hold nothing for us: reconcile prunes the
		// stale claim, so nothing implicates either — untouched coordinators are
		// left to ensureLastResortPublished's demand-driven path.
		fetchQueryMock.mockResolvedValue([]);

		await repairLastResortAlignment();

		expect(withCoordinatorClientRetryMock).not.toHaveBeenCalled();
	});

	test('unreachable coordinator → conservative no-op', async () => {
		const { chatKeyPackagesStore, repairLastResortAlignment } =
			await import('./chatKeyPackages.svelte');
		chatKeyPackagesStore.keyPackages = [
			makeRecord('kp-pick', [], {
				isLastResort: true,
				createdAt: 200,
				keyPackageBase64: 'kp-pick'
			})
		];
		fetchQueryMock.mockRejectedValue(new Error('coordinator down'));

		await repairLastResortAlignment();

		expect(withCoordinatorClientRetryMock).not.toHaveBeenCalled();
	});
});
