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
		setMuted: ReturnType<typeof vi.fn>;
		setCameraEnabled: ReturnType<typeof vi.fn>;
		setScreenShareEnabled: ReturnType<typeof vi.fn>;
	}>,
	joinError: undefined as Error | undefined,
	onJoin: undefined as (() => void) | undefined,
	storageRows: [] as StoredChatMessage[],
	native: {
		start: vi.fn(async () => true),
		stop: vi.fn(async () => {}),
		hangUp: vi.fn(async () => {})
	},
	nativePlatform: false,
	post: vi.fn(async (_options: Record<string, unknown>) => ({
		status: 200,
		headers: {},
		data: '{}'
	}))
}));

vi.mock('$lib/services/nativeShims', () => ({
	isNativePlatform: () => harness.nativePlatform
}));

vi.mock('@capacitor/core', () => ({
	CapacitorHttp: { post: harness.post }
}));

vi.mock('$lib/services/nativeBridge', () => ({
	startNativeCall: harness.native.start,
	stopNativeCall: harness.native.stop,
	onNativeCallHangUp: harness.native.hangUp
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
	getChatStorage: vi.fn(async () => ({
		getGroupMessagesByKinds: vi.fn(async () => harness.storageRows)
	}))
}));

vi.mock('$lib/services/chatGroups.svelte', () => ({
	getChatGroup: () => harness.group,
	decodeStoredGroupState: () => harness.state,
	isChatGroupPoisoned: () => false,
	isChatGroupRemoved: () => false,
	listChatGroupMessages: () => harness.group.messages,
	runGroupOperation: (_groupId: string, operation: () => Promise<unknown>) => operation(),
	sendChatGroupMessage: vi.fn(
		async (input: {
			content: string;
			kind?: number;
			tags?: string[][];
			eventCreatedAt?: number;
		}) => {
			harness.sends.push(input);
			const cursor = harness.group.messages.length + 1;
			const stored: StoredChatMessage = {
				cursor,
				createdAt: 100 + cursor,
				eventCreatedAt: input.eventCreatedAt ?? 100 + cursor,
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
			onState: (state: {
				phase: 'connected';
				muted: boolean;
				participants: Array<unknown>;
				cameraEnabled: boolean;
				screenSharing: boolean;
			}) => void;
			onReconnectTimeout: () => void;
			onDisconnected: () => void;
		};
		join = vi.fn(async () => {
			if (harness.joinError) throw harness.joinError;
			harness.onJoin?.();
			this.callbacks.onState({
				phase: 'connected',
				muted: false,
				cameraEnabled: false,
				screenSharing: false,
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
		setFrameKey = vi.fn(async () => true);
		dispose = vi.fn(async () => {});
		setMuted = vi.fn(async () => {});
		setCameraEnabled = vi.fn(async () => {});
		setScreenShareEnabled = vi.fn(async () => {});
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
	groupCallCards,
	groupCallWindowSignature,
	leaveChatCall,
	loadGroupCalls,
	openChatCall,
	setChatCallCameraEnabled,
	setChatCallMicrophoneEnabled,
	toggleChatCallPinned,
	setChatCallScreenShareEnabled
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
	harness.storageRows = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(JSON.stringify({ token: 'token', url: 'wss://media.example' }), {
					status: 200
				})
		)
	);
}

function statusSends() {
	return harness.sends.map((send) => send.tags?.find((tag) => tag[0] === 'status')?.[1]);
}

function callRow(id: string, createdAt: number, status: 'open' | 'closed'): StoredChatMessage {
	const announcement: CallAnnouncement = {
		callId: '11'.repeat(32),
		service: 'https://hushwire.exe.xyz',
		status,
		startsAt: 100,
		identitySecret: status === 'open' ? '22'.repeat(32) : null
	};
	return {
		cursor: createdAt,
		createdAt,
		eventCreatedAt: createdAt,
		direction: 'inbound',
		sender: bob,
		id,
		kind: ChatKinds.Call,
		tags: createCallAnnouncementTags(announcement),
		content: ''
	};
}

beforeEach(async () => {
	await leaveChatCall({ announce: false });
	chatCallsStore.error = '';
	for (const mock of Object.values(harness.native)) mock.mockClear();
	harness.nativePlatform = false;
	harness.post.mockClear();
});

describe('chat call lifecycle', () => {
	it('posts the token request through native HTTP so the service origin allowlist is not applied', async () => {
		resetGroup('native-token');
		harness.nativePlatform = true;
		harness.post.mockResolvedValueOnce({
			status: 200,
			headers: { 'Content-Length': '42' },
			data: JSON.stringify({ token: 'native-token', url: 'wss://media.example' })
		});
		await openChatCall('native-token');
		await confirmChatCall();
		expect(harness.post).toHaveBeenCalledOnce();
		expect(harness.post.mock.calls[0][0]).toMatchObject({
			url: 'https://hushwire.exe.xyz/api/get-token',
			disableRedirects: true,
			headers: { 'Content-Type': 'application/json' }
		});
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		expect(chatCallsStore.phase).toBe('connected');
	});

	it('withdraws a failed start but does not close a failed join', async () => {
		resetGroup('failed-start');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 503 }))
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

	it('withdraws a start whose end lands in the same second', async () => {
		resetGroup('same-second');
		const now = vi.spyOn(Date, 'now').mockReturnValue(1_762_000_000_000);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 503 }))
		);
		await openChatCall('same-second');
		await confirmChatCall();
		const cards = groupCallCards('same-second');
		expect(cards).toHaveLength(1);
		expect(cards[0].announcement.status).toBe('closed');
		now.mockRestore();
	});

	it('re-reads the durable rows so an ended call is not offered again', async () => {
		resetGroup('read-again');
		const open = callRow('event-open', 100, 'open');
		harness.storageRows = [open];
		await loadGroupCalls('read-again');
		expect(groupCallCards('read-again')[0].announcement.status).toBe('open');

		harness.storageRows = [open, callRow('event-closed', 101, 'closed')];
		await loadGroupCalls('read-again', { force: true });
		expect(groupCallCards('read-again')[0].announcement.status).toBe('closed');
	});

	it('keeps the native keep-alive in step with the call lifecycle', async () => {
		resetGroup('native-call');
		await openChatCall('native-call');
		await confirmChatCall();
		expect(harness.native.start).toHaveBeenCalledOnce();
		expect(harness.native.start).toHaveBeenCalledWith(
			expect.objectContaining({ microphone: true, camera: false })
		);

		// The camera type is re-declared through the same idempotent start.
		await setChatCallCameraEnabled(true);
		expect(harness.native.start).toHaveBeenLastCalledWith(
			expect.objectContaining({ camera: true })
		);

		await leaveChatCall();
		expect(harness.native.stop).toHaveBeenCalledOnce();
	});

	it('stops the native service when the call ends before it finishes starting', async () => {
		resetGroup('native-race');
		let finishStart!: (started: boolean) => void;
		harness.native.start.mockImplementationOnce(
			() => new Promise<boolean>((resolve) => (finishStart = resolve))
		);
		await openChatCall('native-race');
		const connecting = confirmChatCall();
		await vi.waitFor(() => expect(harness.native.start).toHaveBeenCalledOnce());
		await leaveChatCall();
		finishStart(true);
		await connecting;
		expect(harness.native.stop).toHaveBeenCalledOnce();
	});

	it('signs only the call rows so a window change forces a re-read', async () => {
		resetGroup('signature');
		expect(groupCallWindowSignature('signature')).toBe('');
		harness.group.messages.push(callRow('event-open', 1, 'open'));
		expect(groupCallWindowSignature('signature')).toBe('1');
		harness.group.messages.push({
			cursor: 2,
			createdAt: 2,
			eventCreatedAt: 2,
			direction: 'inbound',
			sender: bob,
			id: 'plain',
			kind: ChatKinds.Text,
			tags: [],
			content: 'hi'
		});
		expect(groupCallWindowSignature('signature')).toBe('1');
	});

	it('delegates screen sharing without ending the call when the picker is dismissed', async () => {
		resetGroup('screen-share');
		await openChatCall('screen-share');
		await confirmChatCall();
		const engine = harness.instances[0];

		await setChatCallScreenShareEnabled(true);
		expect(engine.setScreenShareEnabled).toHaveBeenCalledWith(true);
		expect(chatCallsStore.error).toBe('');

		engine.setScreenShareEnabled.mockRejectedValueOnce(
			Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
		);
		await setChatCallScreenShareEnabled(true);
		expect(chatCallsStore.error).toBe('');
		expect(chatCallsStore.active).not.toBeNull();
	});

	it('keeps media toggles truthful when permission or capture fails', async () => {
		resetGroup('media-errors');
		await openChatCall('media-errors');
		await confirmChatCall();
		const engine = harness.instances[0];

		engine.setCameraEnabled.mockRejectedValueOnce(new Error('Camera permission denied'));
		await setChatCallCameraEnabled(true);
		expect(chatCallsStore.cameraEnabled).toBe(false);
		expect(chatCallsStore.error).toBe('Camera permission denied');

		engine.setMuted.mockRejectedValueOnce(new Error('Microphone unavailable'));
		await setChatCallMicrophoneEnabled(false);
		expect(chatCallsStore.microphoneEnabled).toBe(true);
		expect(chatCallsStore.error).toBe('Microphone unavailable');
	});

	it('starts the connection clock once and resets it with the call', async () => {
		resetGroup('call-clock');
		await openChatCall('call-clock');
		expect(chatCallsStore.connectedAt).toBeNull();
		await confirmChatCall();
		const connectedAt = chatCallsStore.connectedAt;
		expect(connectedAt).not.toBeNull();
		await setChatCallCameraEnabled(true);
		expect(chatCallsStore.connectedAt).toBe(connectedAt);
		await leaveChatCall();
		expect(chatCallsStore.connectedAt).toBeNull();
	});

	it('starts on the configured service and joins on the announced one', async () => {
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => (key === 'cordn.callService' ? 'https://calls.example/' : null),
			setItem: vi.fn()
		});
		resetGroup('configured-service');
		await openChatCall('configured-service');
		expect(chatCallsStore.lobby?.service).toBe('https://calls.example');
		await confirmChatCall();
		expect(harness.sends[0].tags?.find(([name]) => name === 'service')?.[1]).toBe(
			'https://calls.example'
		);
		expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://calls.example/api/get-token');

		// A joiner keeps the caller's service: the setting is not a compatibility barrier.
		await leaveChatCall({ announce: false });
		resetGroup('configured-join');
		harness.group.messages.push(callRow('event-open', 1, 'open'));
		await openChatCall('configured-join', 'event-open');
		expect(chatCallsStore.lobby?.service).toBe('https://hushwire.exe.xyz');
	});

	it('pins one participant as the main view and clears it when the call ends', async () => {
		resetGroup('pinned');
		await openChatCall('pinned');
		await confirmChatCall();
		toggleChatCallPinned('peer:device');
		expect(chatCallsStore.pinnedIdentity).toBe('peer:device');
		toggleChatCallPinned('peer:device');
		expect(chatCallsStore.pinnedIdentity).toBeNull();

		toggleChatCallPinned('peer:device');
		await leaveChatCall();
		expect(chatCallsStore.pinnedIdentity).toBeNull();
	});
});
