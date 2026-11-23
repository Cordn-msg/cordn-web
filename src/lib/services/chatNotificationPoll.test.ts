/**
 * The poll runs one lane per coordinator. These cover the isolation the lanes
 * exist for: a coordinator whose read never settles must not delay another
 * coordinator's approval or notification, and a failed welcome read must not
 * skip the signer-free approval pass.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const SLOW = 'aa'.repeat(32);
const FAST = 'bb'.repeat(32);

const h = vi.hoisted(() => ({
	fetchQuery: (_options: unknown) => Promise.resolve(),
	approved: [] as string[],
	approvedNotifications: [] as unknown[],
	joinNotifications: [] as string[],
	welcomeNotifications: [] as string[],
	keys: [] as string[]
}));

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$lib/query-client', () => ({
	queryClient: { fetchQuery: (options: unknown) => h.fetchQuery(options) }
}));

vi.mock('$lib/queries/chatJoinRequestQueries', () => ({
	joinRequestsQueryOptions: (_pubkey: string, key: string) => ({ source: 'join', key })
}));

vi.mock('$lib/queries/chatWelcomeQueries', () => ({
	welcomeNotificationsQueryOptions: (_pubkey: string, key: string) => ({ source: 'welcome', key })
}));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { active: { pubkey: 'ee'.repeat(32) } }
}));

vi.mock('$lib/services/chatAttention.svelte', () => ({
	notifyForApprovedJoinRequests: (approved: unknown[]) => {
		h.approvedNotifications.push(approved);
		return Promise.resolve();
	},
	notifyForJoinRequests: (key: string) => {
		h.joinNotifications.push(key);
		return Promise.resolve();
	},
	notifyForWelcomes: (key: string) => {
		h.welcomeNotifications.push(key);
		return Promise.resolve();
	}
}));

vi.mock('$lib/services/chatAutoApprove.svelte', () => ({
	autoApproveJoinRequests: (key: string) => {
		h.approved.push(key);
		return Promise.resolve([]);
	}
}));

vi.mock('$lib/services/chatCoordinators.svelte', () => ({
	listKnownCoordinatorKeys: () => h.keys,
	getCoordinatorLabel: (key: string) => key
}));

vi.mock('$lib/services/chatRuntime', () => ({
	isSignerUnavailableError: () => false
}));

vi.mock('$lib/services/nativeBridge', () => ({
	isNativePlatform: () => false,
	canRunBackgroundWork: () => true
}));

vi.mock('$lib/utils', () => ({
	errorMessage: (error: unknown) => String(error),
	safeNormalizePubKey: (value: string) => value.trim().toLowerCase()
}));

type PollModule = typeof import('./chatNotificationPoll.svelte');
let poll: PollModule;

beforeEach(async () => {
	h.approved = [];
	h.approvedNotifications = [];
	h.joinNotifications = [];
	h.welcomeNotifications = [];
	h.keys = [SLOW, FAST];
	h.fetchQuery = () => Promise.resolve();
	poll ??= await import('./chatNotificationPoll.svelte');
});

describe('pollNotificationSources', () => {
	test('approves a reachable coordinator without waiting for a stuck one', async () => {
		// The stuck coordinator's read stays pending until the assertions below have
		// run: the reachable lane must approve and notify without it.
		let releaseSlow = () => {};
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		h.fetchQuery = (options) =>
			(options as { key: string }).key === SLOW ? slowGate.then(() => {}) : Promise.resolve();

		const pass = poll.pollNotificationSources();

		await vi.waitFor(() => expect(h.approved).toContain(FAST));
		expect(h.approved).not.toContain(SLOW);
		expect(h.joinNotifications).toContain(FAST);
		expect(h.welcomeNotifications).toContain(FAST);
		expect(h.approvedNotifications).toHaveLength(1);

		releaseSlow();
		await pass;
	});

	test('still approves when the welcome read fails', async () => {
		h.fetchQuery = (options) =>
			(options as { source: string }).source === 'welcome'
				? Promise.reject(new Error('signer unavailable'))
				: Promise.resolve();

		await poll.pollNotificationSources().catch(() => {});

		expect(h.approved).toEqual(expect.arrayContaining([SLOW, FAST]));
		expect(h.joinNotifications).toEqual(expect.arrayContaining([SLOW, FAST]));
	});

	test('reports a failed coordinator read without dropping the others', async () => {
		h.fetchQuery = (options) =>
			(options as { key: string }).key === SLOW
				? Promise.reject(new Error('coordinator down'))
				: Promise.resolve();

		await poll.pollNotificationSources();

		// A failed read still gets its approval pass: requests are already durable,
		// and the guardrails (switch age, membership, removals) are re-checked there.
		expect(h.approved).toEqual(expect.arrayContaining([SLOW, FAST]));
		expect(h.joinNotifications).toContain(FAST);
		expect(poll.notificationPollState.failures).toHaveLength(1);
		expect(poll.notificationPollState.failures[0]).toContain('coordinator down');
	});
});
