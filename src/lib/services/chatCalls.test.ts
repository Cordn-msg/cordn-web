import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatKinds } from '$lib/chat/kinds';
import { createCallAnnouncementTags, type CallAnnouncement } from '$lib/chat/calls';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
import type { StoredChatGroup } from '$lib/services/chatGroups.svelte';

const alice = 'aa'.repeat(32);
const bob = 'bb'.repeat(32);

const harness = vi.hoisted(() => ({
	group: undefined as unknown as StoredChatGroup,
	state: undefined as unknown as {
		groupContext: { epoch: bigint };
		keySchedule: { exporterSecret: Uint8Array };
	},
	sends: [] as Array<{ content: string; kind?: number; tags?: string[][] }>,
	instances: [] as Array<{
		join: ReturnType<typeof vi.fn>;
		setFrameKey: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	}>,
	joinError: undefined as Error | undefined,
	onJoin: undefined as (() => void) | undefined
}));

vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: {
		getActive: () => ({ id: 'account-1', pubkey: alice }),
		active$: { subscribe: vi.fn() }
	}
}));

vi.mock('ts-mls', () => ({
	mlsExporter: vi.fn(async (secret: Uint8Array) => secret)
}));

vi.mock('$lib/services/chatMlsUtils', () => ({ getCordnCipherSuite: vi.fn(async () => ({})) }));
vi.mock('$lib/services/chatAdminPolicy', () => ({
	listGroupMembers: () => [{ stablePubkey: alice }]
}));
vi.mock('$lib/storage/chatStorage', () => ({
	getChatStorage: vi.fn(async () => ({ getGroupMessagesByKinds: vi.fn(async () => []) }))
}));

vi.mock('$lib/services/chatGroups.svelte', () => ({
	getChatGroup: () => harness.group,
	decodeStoredGroupState: () => harness.state,
	isChatGroupPoisoned: () => false,
	isChatGroupRemoved: () => false,
	listChatGroupMessages: () => harness.group.messages,
	runGroupOperation: (_groupId: string, operation: () => Promise<unknown>) => operation(),
	sendChatGroupMessage: vi.fn(
		async (input: { content: string; kind?: number; tags?: string[][] }) => {
			harness.sends.push(input);
			const cursor = harness.group.messages.length + 1;
			const stored: StoredChatMessage = {
				cursor,
				createdAt: 100 + cursor,
				eventCreatedAt: 100 + cursor,
				direction: 'outbound',
				sender: alice,
				id: `event-${cursor}`,
				kind: input.kind ?? ChatKinds.Text,
				tags: input.tags ?? [],
				content: input.content
			};
			harness.group.messages.push(stored);
			return stored;
		}
	)
}));

vi.mock('$lib/services/liveKitCallEngine', () => ({
	LiveKitCallEngine: class {
		callbacks: {
			onState: (state: { participants: Array<unknown> }) => void;
			onReconnectTimeout: () => void;
			onDisconnected: () => void;
		};
		join = vi.fn(async () => {
			if (harness.joinError) throw harness.joinError;
			harness.onJoin?.();
			this.callbacks.onState({
				participants: [
					{
						identity: 'own',
						isLocal: true,
						isSpeaking: false,
						microphoneEnabled: true,
						cameraEnabled: false
					}
				]
			});
		});
		setFrameKey = vi.fn(async () => {});
		dispose = vi.fn(async () => {});
		setMuted = vi.fn(async () => {});
		setCameraEnabled = vi.fn(async () => {});
		attachVideo = vi.fn();
		detachVideo = vi.fn();

		constructor(callbacks: typeof this.callbacks) {
			this.callbacks = callbacks;
			harness.instances.push(this);
		}
	}
}));

import {
	chatCallsStore,
	confirmChatCall,
	leaveChatCall,
	openChatCall
} from '$lib/services/chatCalls.svelte';

function resetGroup(groupId: string) {
	harness.state = {
		groupContext: { epoch: 0n },
		keySchedule: { exporterSecret: Uint8Array.from({ length: 32 }, (_, i) => i) }
	};
	harness.group = {
		id: groupId,
		messages: [],
		stateBase64: 'state',
		status: 'active'
	} as unknown as StoredChatGroup;
	harness.sends = [];
	harness.instances = [];
	harness.joinError = undefined;
	harness.onJoin = undefined;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ token: 'token', url: 'wss://media.example' })
		}))
	);
}

function statusSends() {
	return harness.sends.map((send) => send.tags?.find((tag) => tag[0] === 'status')?.[1]);
}

beforeEach(async () => {
	await leaveChatCall({ announce: false });
	chatCallsStore.error = '';
});

describe('chat call lifecycle', () => {
	it('withdraws a failed start but does not close a failed join', async () => {
		resetGroup('failed-start');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 503, text: async () => '' }))
		);
		await openChatCall('failed-start');
		await confirmChatCall();
		expect(statusSends()).toEqual(['open', 'closed']);
		expect(chatCallsStore.error).toContain('503');

		resetGroup('failed-join');
		const announcement: CallAnnouncement = {
			callId: '11'.repeat(32),
			service: 'https://hushwire.exe.xyz',
			status: 'open',
			startsAt: 100,
			identitySecret: '22'.repeat(32)
		};
		harness.group.messages.push({
			cursor: 1,
			createdAt: 100,
			eventCreatedAt: 100,
			direction: 'inbound',
			sender: bob,
			id: 'call-open',
			kind: ChatKinds.Call,
			tags: createCallAnnouncementTags(announcement),
			content: ''
		});
		await openChatCall('failed-join', 'call-open');
		await confirmChatCall();
		expect(harness.sends).toEqual([]);
	});

	it('reconciles an epoch that advances during the media handshake', async () => {
		resetGroup('epoch-during-connect');
		await openChatCall('epoch-during-connect');
		harness.onJoin = () => {
			// A commit lands: the bytes are the state, so both move together.
			harness.state.groupContext.epoch = 17n;
			harness.state.keySchedule.exporterSecret = Uint8Array.from(
				{ length: 32 },
				(_, index) => index + 1
			);
			harness.group.stateBase64 = 'state-after-commit';
		};
		await confirmChatCall();
		const engine = harness.instances[0];
		const initialIndex = engine.join.mock.calls[0][0].keyIndex;
		expect(initialIndex).toBe(0);
		expect(engine.setFrameKey).toHaveBeenCalledOnce();
		expect(engine.setFrameKey.mock.calls[0][1]).toBe(1);
		expect(engine.setFrameKey.mock.calls[0][0]).not.toBe(engine.join.mock.calls[0][0].frameKey);
	});

	it('closes on last-member-out and not while another member remains', async () => {
		resetGroup('last-out');
		await openChatCall('last-out');
		await confirmChatCall();
		await leaveChatCall();
		expect(statusSends()).toEqual(['open', 'closed']);
	});
});
