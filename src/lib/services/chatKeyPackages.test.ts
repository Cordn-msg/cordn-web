import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { StoredKeyPackageRecord } from './chatKeyPackages.svelte';

const withCoordinatorClientMock = vi.fn(
	<T>(_account: unknown, _coordinatorKey: string, operation: (client: T) => Promise<unknown>) =>
		operation({ RemoveKeyPackages: vi.fn().mockResolvedValue({}) } as unknown as T)
);
const requireActiveAccountMock = vi.fn(() => ({ pubkey: 'aa'.repeat(32) }));
const fetchQueryMock = vi.fn();
const invalidateQueriesMock = vi.fn().mockResolvedValue(undefined);
const getQueryDataMock = vi.fn();
const markCoordinatorUsedMock = vi.fn();

vi.mock('ts-mls', async () => {
	const actual = await vi.importActual<typeof import('ts-mls')>('ts-mls');
	return { ...actual };
});

vi.mock('$app/environment', () => ({ browser: false }));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { getActive: () => ({ pubkey: 'aa'.repeat(32) }) }
}));

vi.mock('$lib/services/chatRuntime', () => ({
	requireActiveAccount: requireActiveAccountMock,
	withCoordinatorClient: withCoordinatorClientMock
}));

vi.mock('$lib/services/chatCoordinators.svelte', () => ({
	markCoordinatorUsed: markCoordinatorUsedMock
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

function makeRecord(ref: string, coordinators: string[]): StoredKeyPackageRecord {
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
		publishedCoordinatorKeys: coordinators
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
