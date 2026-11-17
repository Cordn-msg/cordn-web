/**
 * Tab-title ownership (chatAttention): syncChatAttention is the single writer —
 * route heads must not set <title> or the unread badge flips between writers.
 * The label table below replaced 16 route-local titles; these tests pin it and
 * the write-on-change guard (the caller effect re-runs per ingested batch).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	hasUnreadChatAttention,
	notifyForUnreadChatMessages,
	syncChatAttention
} from './chatAttention.svelte';
import { ensureNotificationPermission, showLocalNotification } from './nativeBridge';

const harness = vi.hoisted(() => ({
	title: '' as string,
	titleWrites: 0,
	pathname: '/chat',
	searchParams: new URLSearchParams(),
	groups: [] as Array<Record<string, unknown>>,
	muted: new Set<string>(),
	cutoff: new Map<string, number>()
}));

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return { pathname: harness.pathname, searchParams: harness.searchParams };
		}
	}
}));

vi.stubGlobal('document', {
	get title() {
		return harness.title;
	},
	set title(value: string) {
		harness.title = value;
		harness.titleWrites++;
	},
	querySelector: () => ({ getAttribute: () => '/favicon.svg', href: '' }),
	createElement: () => ({ href: '' }),
	head: { append: () => undefined },
	visibilityState: 'hidden',
	hasFocus: () => false
});

vi.mock('$lib/services/nativeBridge', () => ({
	clearShownNotifications: () => Promise.resolve(),
	ensureNotificationPermission: vi.fn(),
	isNativePlatform: () => false,
	showLocalNotification: vi.fn()
}));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { active: { pubkey: 'aa'.repeat(32) } }
}));

vi.mock('$lib/services/chatGroupPresence.svelte', () => ({
	getChatGroupLastReadCursor: () => 0,
	getUnreadChatGroupMessageCount: (id: string) => (id === 'g1' ? 2 : 0),
	getUnreadChatGroupReferenceCount: () => 0
}));

vi.mock('$lib/services/chatWelcomeNotifications.svelte', () => ({
	getUnreadWelcomeNotificationCount: () => 0
}));

vi.mock('$lib/services/chatJoinRequests.svelte', () => ({
	getUnreadJoinRequestCount: () => 0
}));

vi.mock('$lib/news/newsReadState.svelte', () => ({
	getUnreadNewsCount: () => 0
}));

vi.mock('$lib/services/chatGroups.svelte', () => ({
	getChatGroup: (id: string) => harness.groups.find((group) => group.id === id),
	listChatGroups: () => harness.groups,
	listChatGroupMembers: () => []
}));

vi.mock('$lib/services/chatGroupMutes.svelte', () => ({
	getChatGroupMuteCutoff: (id: string) => harness.cutoff.get(id) ?? 0,
	isChatGroupMuted: (id: string) => harness.muted.has(id)
}));

vi.mock('$lib/services/chatNotificationSettings', () => ({
	getNotificationPreviewsEnabled: () => false
}));

vi.mock('$lib/services/chatCoordinators.svelte', () => ({
	getCoordinatorLabel: (key: string) => (key === 'ck1' ? 'Coordinator One' : key)
}));

vi.mock('$lib/utils/groupShareLink', () => ({
	// Bare-gid passthrough: enough to drive getChatGroup lookups per route.
	resolveGroupLocator: (id: string) => ({
		gid: id,
		coordinatorKey: 'cc'.repeat(32),
		coordinatorProvided: false,
		coordinatorError: '',
		shareMetadata: null
	})
}));

vi.mock('$lib/services/eventStore', () => ({ eventStore: {} }));
vi.mock('applesauce-core/observable', () => ({ firstValueFrom: vi.fn() }));
vi.mock('applesauce-core/models', () => ({ ProfileModel: class {} }));

beforeEach(() => {
	harness.title = '';
	harness.titleWrites = 0;
	harness.pathname = '/chat';
	harness.muted.clear();
	harness.cutoff.clear();
	harness.groups = [
		{ id: 'g1', metadata: { name: 'Besao' }, lastCursor: 0, messages: [] },
		{ id: 'g2', lastCursor: 0, messages: [] }
	];
});

function inbound(cursor: number, createdAt = Date.now()) {
	return {
		id: `m${cursor}`,
		cursor,
		createdAt,
		direction: 'inbound',
		sender: 'cc'.repeat(32),
		kind: 1,
		tags: [],
		content: `hi ${cursor}`
	};
}

describe('notification mutes', () => {
	test('muted passes advance the cursor silently; expiry never replays the backlog', async () => {
		vi.mocked(ensureNotificationPermission).mockResolvedValue(true);
		vi.mocked(showLocalNotification).mockClear();
		const g1 = harness.groups[0]!;

		// First pass only seeds the per-group cursor.
		await notifyForUnreadChatMessages();

		g1.lastCursor = 1;
		g1.messages = [inbound(1)];
		harness.muted.add('g1');
		await notifyForUnreadChatMessages();
		expect(showLocalNotification).not.toHaveBeenCalled();

		// Unmuted with one newer message: only that one notifies, never message 1.
		harness.muted.delete('g1');
		g1.lastCursor = 2;
		g1.messages = [inbound(1), inbound(2)];
		await notifyForUnreadChatMessages();
		expect(showLocalNotification).toHaveBeenCalledTimes(1);
		expect(vi.mocked(showLocalNotification).mock.calls[0]![0]).toMatchObject({
			groupId: 'g1',
			count: 1
		});

		// A fetch straddling expiry: the pre-cutoff message stays silent.
		const cutoff = Date.now() - 1_000;
		harness.cutoff.set('g1', cutoff);
		g1.lastCursor = 4;
		g1.messages = [inbound(1), inbound(2), inbound(3, cutoff - 5_000), inbound(4)];
		await notifyForUnreadChatMessages();
		expect(showLocalNotification).toHaveBeenCalledTimes(2);
		expect(vi.mocked(showLocalNotification).mock.calls[1]![0]).toMatchObject({
			groupId: 'g1',
			count: 1
		});
	});
});

describe('attention dots', () => {
	test('muted groups keep their unread count but raise no attention dot', () => {
		expect(hasUnreadChatAttention()).toBe(true);

		harness.muted.add('g1');
		expect(hasUnreadChatAttention()).toBe(false);

		// The count sources are untouched: only the dot ignores mutes.
		syncChatAttention();
		expect(harness.title).toBe('(2) Chats | Cordn');
	});
});

describe('chat page title', () => {
	test('one label table, badged from the same unread sources', () => {
		const expectTitle = (pathname: string, title: string) => {
			harness.pathname = pathname;
			syncChatAttention();
			expect(harness.title).toBe(title);
		};

		expectTitle('/chat', '(2) Chats | Cordn');
		expectTitle('/chat/news', '(2) News & updates | Cordn');
		expectTitle('/chat/config', '(2) Settings | Cordn');
		expectTitle('/chat/config/key-packages', '(2) Key packages | Cordn');
		expectTitle('/chat/coordinators', '(2) Coordinators | Cordn');
		expectTitle('/chat/coordinators/ck1', '(2) Coordinator One | Cordn');
		expectTitle('/chat/g1', '(2) Besao | Cordn');
		expectTitle('/chat/g1/info', '(2) Besao | Cordn');
		expectTitle('/chat/g1/e/abc', '(2) Message | Besao | Cordn');
		expectTitle('/chat/g2', '(2) Chat | Cordn');
	});

	test('writes the title only when it changes', () => {
		syncChatAttention();
		const writes = harness.titleWrites;
		syncChatAttention();
		syncChatAttention();
		expect(harness.titleWrites).toBe(writes);
	});
});
