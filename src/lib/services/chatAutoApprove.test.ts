/**
 * The auto-approve runner's guards: which requests it hands to one batch invite,
 * what it reports back for the "approved" notification, and how failures are
 * counted. The pure selection rules live in chatAutoApprovePolicy.test.ts; this
 * covers the side effects (submitting flags, accepted marks, attempts).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SYSTEM_MESSAGE_KIND } from '$lib/chat/kinds';

const ADMIN = 'ee'.repeat(32);
const ALICE = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const GROUP = 'group-1';

interface Entry {
	id: string;
	groupId: string;
	requesterStablePubkey: string;
	at: number;
	status?: 'pending' | 'accepted' | 'dismissed';
}

const h = vi.hoisted(() => ({
	entries: [] as Entry[],
	submitting: new Set<string>(),
	members: [] as string[],
	metadata: { name: 'Test group' } as Record<string, unknown>,
	multiDevice: false,
	native: false,
	canRunBackground: true,
	accepted: [] as Array<{ id: string; groupId: string }>,
	inviteCalls: [] as Array<{ groupId: string; targets: Array<{ identifier: string }> }>,
	invite: (_input: unknown) =>
		Promise.resolve({ group: { id: GROUP }, failures: [] as Array<{ identifier: string }> }),
	/** Durable system rows the removal guard reads. */
	removedRows: [] as Array<{ kind: number; content: string }>,
	removedRowsError: false
}));

vi.mock('$lib/storage/chatStorage', () => ({
	getChatStorage: () =>
		h.removedRowsError
			? Promise.reject(new Error('storage unavailable'))
			: Promise.resolve({ getGroupMessagesByKinds: () => Promise.resolve(h.removedRows) })
}));

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { getActive: () => ({ pubkey: 'ee'.repeat(32) }) }
}));

vi.mock('$lib/services/nativeBridge', () => ({
	isNativePlatform: () => h.native,
	canRunBackgroundWork: () => h.canRunBackground
}));

vi.mock('$lib/services/multiDevice.svelte', () => ({
	isMultiDeviceActive: () => h.multiDevice
}));

vi.mock('$lib/services/chatGroups.svelte', () => ({
	ensureGroupsLoaded: () => Promise.resolve(),
	getChatGroup: () => ({ id: GROUP, metadata: h.metadata, messages: [] }),
	inviteChatGroupMembers: (input: { groupId: string; targets: Array<{ identifier: string }> }) => {
		h.inviteCalls.push(input);
		return h.invite(input);
	},
	listChatGroupMembers: () => h.members.map((stablePubkey) => ({ stablePubkey }))
}));

vi.mock('$lib/services/chatJoinRequests.svelte', () => ({
	listJoinRequests: () =>
		h.entries.filter((entry) => entry.status !== 'accepted' && entry.status !== 'dismissed'),
	isJoinRequestSubmitting: (id: string) => h.submitting.has(id),
	setJoinRequestSubmitting: (id: string) => void h.submitting.add(id),
	clearJoinRequestSubmitting: (id: string) => void h.submitting.delete(id),
	markJoinRequestAccepted: (id: string, groupId: string) => {
		h.accepted.push({ id, groupId });
		const entry = h.entries.find((candidate) => candidate.id === id);
		if (entry) entry.status = 'accepted';
	}
}));

type AutoApproveModule = typeof import('./chatAutoApprove.svelte');
let autoApprove: AutoApproveModule;

const storage = new Map<string, string>();

beforeEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	storage.clear();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key)
	});
	h.entries = [];
	h.submitting.clear();
	h.members = [];
	h.metadata = { name: 'Test group' };
	h.multiDevice = false;
	h.native = false;
	h.canRunBackground = true;
	h.accepted = [];
	h.inviteCalls = [];
	h.invite = () => Promise.resolve({ group: { id: GROUP }, failures: [] });
	h.removedRows = [];
	h.removedRowsError = false;
	autoApprove ??= await import('./chatAutoApprove.svelte');
	autoApprove.loadChatAutoApproveForOwner(ADMIN);
});

function request(id: string, requester: string, at = Date.now() + 1_000): Entry {
	return { id, groupId: GROUP, requesterStablePubkey: requester, at };
}

function removal(target: string) {
	return {
		kind: SYSTEM_MESSAGE_KIND,
		content: JSON.stringify({ systemKind: 'member-removed', target })
	};
}

describe('autoApproveJoinRequests', () => {
	test('approves an enabled group in one batch and reports who it let in', async () => {
		h.entries = [request('a', ALICE), request('b', BOB)];
		autoApprove.setAutoApproveEnabled(GROUP, true);

		const approved = await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(1);
		expect(h.inviteCalls[0].targets.map((target) => target.identifier)).toEqual([ALICE, BOB]);
		expect(h.accepted.map((mark) => mark.id)).toEqual(['a', 'b']);
		expect(approved).toEqual([
			{ groupId: GROUP, requester: ALICE },
			{ groupId: GROUP, requester: BOB }
		]);
	});

	test('marks a request from a current member accepted without inviting', async () => {
		h.members = [ALICE];
		h.entries = [request('a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);

		const approved = await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(0);
		expect(h.accepted).toEqual([{ id: 'a', groupId: GROUP }]);
		expect(approved).toEqual([]);
	});

	test('holds the request as submitting while the invite is in flight', async () => {
		const seen: boolean[] = [];
		h.entries = [request('a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);
		h.invite = () => {
			seen.push(h.submitting.has('a'));
			return Promise.resolve({ group: { id: GROUP }, failures: [] });
		};

		await autoApprove.autoApproveJoinRequests();

		expect(seen).toEqual([true]);
		expect(h.submitting.has('a')).toBe(false);
	});

	test('leaves a failed target pending and counts the attempt', async () => {
		h.entries = [request('failed-a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);
		h.invite = () => Promise.resolve({ group: { id: GROUP }, failures: [{ identifier: ALICE }] });

		const approved = await autoApprove.autoApproveJoinRequests();

		expect(approved).toEqual([]);
		expect(h.accepted).toEqual([]);
		expect(h.entries[0].status).toBeUndefined();
		expect(h.submitting.has('failed-a')).toBe(false);
	});

	test('counts an attempt for every target when the batch throws, then gives up after three', async () => {
		h.entries = [request('throwing-a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);
		h.invite = () => Promise.reject(new Error('coordinator down'));

		for (let pass = 0; pass < 3; pass += 1) {
			await autoApprove.autoApproveJoinRequests();
		}
		expect(h.inviteCalls).toHaveLength(3);
		expect(h.submitting.size).toBe(0);

		// Out of attempts: the request stays for a human.
		await autoApprove.autoApproveJoinRequests();
		expect(h.inviteCalls).toHaveLength(3);
	});

	test('never auto-approves someone removed outside the loaded message window', async () => {
		h.removedRows = [removal(ALICE)];
		h.entries = [request('removed-a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);

		await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(0);
	});

	test('leaves the group for a human when the removal history cannot be read', async () => {
		h.removedRowsError = true;
		h.entries = [request('unreadable-a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);

		await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(0);
	});

	test('closes a duplicate request from someone the batch just approved', async () => {
		h.entries = [request('dup-old', ALICE), request('dup-new', ALICE, Date.now() + 2_000)];
		autoApprove.setAutoApproveEnabled(GROUP, true);
		h.invite = () => {
			h.members = [ALICE];
			return Promise.resolve({ group: { id: GROUP }, failures: [] });
		};

		const approved = await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls[0].targets.map((target) => target.identifier)).toEqual([ALICE]);
		expect(approved).toEqual([{ groupId: GROUP, requester: ALICE }]);
		expect(h.accepted.map((mark) => mark.id).sort()).toEqual(['dup-new', 'dup-old']);
	});

	test('skips a group whose switch is off', async () => {
		h.entries = [request('a', ALICE)];

		await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(0);
	});

	test('skips a group the active account does not administer', async () => {
		h.metadata = { name: 'Test group', adminPubkeys: [BOB] };
		h.entries = [request('a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);

		await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(0);
	});

	test('never sweeps in a request older than the switch', async () => {
		h.entries = [request('a', ALICE, Date.now() - 60_000)];
		autoApprove.setAutoApproveEnabled(GROUP, true);

		await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(0);
	});

	test('skips backgrounded native passes while multi-device sync is on', async () => {
		h.native = true;
		h.multiDevice = true;
		h.entries = [request('background-a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);
		vi.stubGlobal('document', { visibilityState: 'hidden' });

		await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(0);
	});

	test('skips background passes where the platform cannot keep the app running', async () => {
		h.canRunBackground = false;
		h.entries = [request('frozen-a', ALICE)];
		autoApprove.setAutoApproveEnabled(GROUP, true);

		await autoApprove.autoApproveJoinRequests();

		expect(h.inviteCalls).toHaveLength(0);
	});
});
