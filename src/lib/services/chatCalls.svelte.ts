import { browser } from '$app/environment';
import { untrack } from 'svelte';
import { mlsExporter, type ClientState } from 'ts-mls';
import { manager } from '$lib/services/accountManager.svelte';
import {
	decodeStoredGroupState,
	getChatGroup,
	isChatGroupPoisoned,
	isChatGroupRemoved,
	listChatGroupMessages,
	runGroupOperation,
	sendChatGroupMessage,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import { getCordnCipherSuite } from '$lib/services/chatMlsUtils';
import { listGroupMembers } from '$lib/services/chatAdminPolicy';
import { getChatStorage } from '$lib/storage/chatStorage';
import { errorMessage, normalizePubKey } from '$lib/utils';
import { ChatKinds } from '$lib/chat/kinds';
import {
	buildCallProjection,
	createCallAnnouncementTags,
	createCallTokenRequest,
	DEFAULT_CALL_SERVICE,
	deriveCallJoinMaterial,
	deriveCallPseudonym,
	findCallCard,
	liveCallCard,
	newCallDeviceTag,
	newCallId,
	newCallIdentitySecret,
	parseCallTokenGrant,
	CALL_EXPORTER_CONTEXT,
	CALL_EXPORTER_LABEL,
	callPseudonymOf,
	type CallAnnouncement,
	type CallCard,
	type CallJoinMaterial
} from '$lib/chat/calls';
import {
	LiveKitCallEngine,
	type CallEngineState,
	type CallParticipant,
	type CallPhase
} from '$lib/services/liveKitCallEngine';

interface PendingCall {
	kind: 'start' | 'join';
	groupId: string;
	callId: string;
	service: string;
	startsAt: number;
	identitySecret: string;
}

interface CallSnapshot {
	rows: import('$lib/services/chatGroupMessages.svelte').StoredChatMessage[];
	loaded: boolean;
}

interface GroupCallSnapshot {
	epoch: bigint;
	exporter: Uint8Array;
	memberPubkeys: string[];
}

interface ActiveCallSession extends PendingCall {
	started: boolean;
	accountPubkey: string;
	deviceTag: string;
	engine: LiveKitCallEngine;
	material?: CallJoinMaterial;
	epoch?: bigint;
	pseudonyms: Map<string, string>;
	members: Set<string>;
	participants: CallParticipant[];
	connected: boolean;
	announcedOpen: boolean;
	reannounceOnConnect: boolean;
	/** The MLS state the installed frame key came from — the re-key gate. */
	stateBase64?: string;
	sync: Promise<void>;
}

export const chatCallsStore = $state<{
	dialogOpen: boolean;
	busy: boolean;
	lobby: { groupId: string; callId?: string; service: string } | null;
	active: { groupId: string; callId: string; service: string } | null;
	phase: CallPhase | 'idle';
	error: string;
	microphoneEnabled: boolean;
	cameraEnabled: boolean;
	participants: CallParticipant[];
}>({
	dialogOpen: false,
	busy: false,
	lobby: null,
	active: null,
	phase: 'idle',
	error: '',
	microphoneEnabled: true,
	cameraEnabled: false,
	participants: []
});

const EMPTY_SNAPSHOT: CallSnapshot = { rows: [], loaded: false };
const snapshots = $state<Record<string, CallSnapshot>>({});
const snapshotReads = new Map<string, Promise<void>>();
const deviceTags = new Map<string, string>();
let activeSession: ActiveCallSession | null = null;
let pendingCall: PendingCall | null = null;
let generation = 0;

function callSnapshot(groupId: string): CallSnapshot {
	return snapshots[groupId] ?? EMPTY_SNAPSHOT;
}

/** `force` re-reads: a call's end can leave the window after the snapshot was taken,
 *  and the stale snapshot would then offer a call that is over as live. */
export async function loadGroupCalls(
	groupId: string,
	options: { force?: boolean } = {}
): Promise<void> {
	const pending = snapshotReads.get(groupId);
	if (pending) return pending;
	if (!options.force && callSnapshot(groupId).loaded) return;
	const owner = manager.getActive()?.id;
	const promise = getChatStorage()
		.then((storage) => storage.getGroupMessagesByKinds(groupId, [ChatKinds.Call]))
		.then((rows) => {
			if (manager.getActive()?.id === owner) snapshots[groupId] = { rows, loaded: true };
		})
		.catch(() => {
			// The live window still provides calls; a durable read can be retried next mount.
			if (manager.getActive()?.id === owner) snapshots[groupId] = { rows: [], loaded: false };
		})
		.finally(() => snapshotReads.delete(groupId));
	snapshotReads.set(groupId, promise);
	return promise;
}

export function groupCallCards(groupId: string): CallCard[] {
	const byCursor = new Map(callSnapshot(groupId).rows.map((row) => [row.cursor, row]));
	for (const row of listChatGroupMessages(groupId)) {
		if (row.kind === ChatKinds.Call) byCursor.set(row.cursor, row);
	}
	return buildCallProjection([...byCursor.values()].sort((a, b) => a.cursor - b.cursor));
}

export function groupCallCard(groupId: string, eventId: string): CallCard | null {
	return findCallCard(groupCallCards(groupId), eventId);
}

function unusableGroup(group: StoredChatGroup | undefined): boolean {
	return Boolean(
		!group ||
		isChatGroupRemoved(group) ||
		isChatGroupPoisoned(group) ||
		group.skippedSiblingCommit ||
		group.branch?.kind === 'dead' ||
		group.staleMark
	);
}

async function readGroupCallSnapshot(groupId: string): Promise<GroupCallSnapshot> {
	return runGroupOperation(groupId, async () => {
		const group = getChatGroup(groupId);
		if (unusableGroup(group) || !group) {
			throw new Error('This chat needs to be healthy before joining a call');
		}
		const state: ClientState = decodeStoredGroupState(group);
		const cipherSuite = await getCordnCipherSuite();
		const exporter = await mlsExporter(
			state.keySchedule.exporterSecret,
			CALL_EXPORTER_LABEL,
			new TextEncoder().encode(CALL_EXPORTER_CONTEXT),
			32,
			cipherSuite
		);
		return {
			epoch: state.groupContext.epoch,
			exporter,
			memberPubkeys: listGroupMembers(state).map((member) => normalizePubKey(member.stablePubkey))
		};
	});
}

function deriveMaterial(session: ActiveCallSession, snapshot: GroupCallSnapshot): CallJoinMaterial {
	return deriveCallJoinMaterial({
		exporter: snapshot.exporter,
		callId: session.callId,
		identitySecret: session.identitySecret,
		memberPubkey: session.accountPubkey,
		memberPubkeys: snapshot.memberPubkeys,
		deviceTag: session.deviceTag,
		epoch: snapshot.epoch
	});
}

function applyMaterial(
	session: ActiveCallSession,
	snapshot: GroupCallSnapshot,
	material = deriveMaterial(session, snapshot)
) {
	session.material = material;
	session.epoch = snapshot.epoch;
	session.pseudonyms = new Map([...session.pseudonyms, ...material.pseudonyms]);
	const added =
		session.members.size > 0 &&
		snapshot.memberPubkeys.some((pubkey) => !session.members.has(pubkey));
	if (added && !session.connected) session.reannounceOnConnect = true;
	session.members = new Set(snapshot.memberPubkeys);
	return added;
}

/** Capped while reading: a hostile service must not be able to buffer an arbitrary
 *  body into the page before the size is checked. */
async function readCappedBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error('The call service returned no token');
	const decoder = new TextDecoder();
	let text = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
		if (text.length > 16_384) {
			await reader.cancel().catch(() => {});
			throw new Error('The call service returned an oversized response');
		}
	}
	return text + decoder.decode();
}

async function requestToken(session: ActiveCallSession): Promise<{ token: string; url: string }> {
	if (!session.material) throw new Error('Call keys are not ready');
	const request = createCallTokenRequest({
		service: session.service,
		callId: session.callId,
		identity: session.material.identity,
		privateKey: session.material.privateKey,
		publicKey: session.material.publicKey
	});
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(request.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: request.body,
			signal: controller.signal,
			redirect: 'error'
		});
		if (response.status === 402) throw new Error('The call service requires a subscription');
		if (response.status === 403)
			throw new Error('The call service refused this room or browser origin');
		if (response.status === 429)
			throw new Error('The call service is rate limiting requests; try again shortly');
		if (!response.ok) throw new Error(`The call service returned HTTP ${response.status}`);
		return parseCallTokenGrant(JSON.parse(await readCappedBody(response)));
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error('The call service did not respond in time', { cause: error });
		}
		if (error instanceof SyntaxError) {
			throw new Error('The call service returned malformed JSON', { cause: error });
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function announcementFor(session: ActiveCallSession, status: 'open' | 'closed'): CallAnnouncement {
	return {
		callId: session.callId,
		service: session.service,
		status,
		startsAt: session.startsAt,
		identitySecret: status === 'open' ? session.identitySecret : null,
		...(status === 'closed' ? { endsAt: Math.floor(Date.now() / 1000) } : {})
	};
}

async function announce(session: ActiveCallSession, status: 'open' | 'closed') {
	// Revisions order by the envelope's `created_at`, then by event id. An end written in
	// the same second as the announcement it answers could lose that tie-break and leave
	// the call reading as live, so every revision of a call is stamped strictly later.
	const previous =
		groupCallCards(session.groupId).find((card) => card.announcement.callId === session.callId)
			?.message.eventCreatedAt ?? 0;
	await sendChatGroupMessage({
		groupId: session.groupId,
		content: '',
		kind: ChatKinds.Call,
		tags: createCallAnnouncementTags(announcementFor(session, status)),
		eventCreatedAt: Math.max(Math.floor(Date.now() / 1000), previous + 1)
	});
}

function resetEngineState() {
	chatCallsStore.active = null;
	chatCallsStore.phase = 'idle';
	chatCallsStore.busy = false;
	chatCallsStore.participants = [];
}

async function disposeSession(session: ActiveCallSession) {
	if (activeSession !== session) return;
	activeSession = null;
	generation++;
	await session.engine.dispose();
	resetEngineState();
}

async function closeIfLastMember(session: ActiveCallSession) {
	const latest = groupCallCards(session.groupId).find(
		(card) => card.announcement.callId === session.callId
	);
	if (latest?.announcement.status !== 'open') return;
	const currentMembers = await readGroupCallSnapshot(session.groupId).catch(() => null);
	if (!currentMembers) return;
	const currentPseudonyms = new Set(
		currentMembers.memberPubkeys.map((pubkey) =>
			deriveCallPseudonym(session.identitySecret, pubkey)
		)
	);
	const ownPseudonym = session.material?.pseudonym;
	const anotherMember = session.participants.some((participant) => {
		const pseudonym = callPseudonymOf(participant.identity);
		return !participant.isLocal && pseudonym !== ownPseudonym && currentPseudonyms.has(pseudonym);
	});
	if (!anotherMember) await announce(session, 'closed');
}

async function failSession(session: ActiveCallSession, error: unknown) {
	if (activeSession !== session) return;
	if (session.connected) await closeIfLastMember(session).catch(() => {});
	else if (session.started && session.announcedOpen)
		await announce(session, 'closed').catch(() => {});
	await disposeSession(session);
	pendingCall = session;
	chatCallsStore.lobby = {
		groupId: session.groupId,
		// A retried START is still this device's own call, so it must not offer to "join" it.
		callId: session.kind === 'join' ? session.callId : undefined,
		service: session.service
	};
	chatCallsStore.dialogOpen = true;
	chatCallsStore.error = errorMessage(error);
}

export async function leaveChatCall(options: { announce?: boolean; error?: string } = {}) {
	const session = activeSession;
	if (!session) {
		chatCallsStore.dialogOpen = false;
		pendingCall = null;
		chatCallsStore.lobby = null;
		return;
	}
	const shouldAnnounce = options.announce !== false && session.connected;
	const withdrawing =
		options.announce !== false && session.started && session.announcedOpen && !session.connected;
	await disposeSession(session);
	if (shouldAnnounce) await closeIfLastMember(session).catch(() => {});
	else if (withdrawing) await announce(session, 'closed').catch(() => {});
	pendingCall = null;
	chatCallsStore.lobby = null;
	chatCallsStore.dialogOpen = false;
	chatCallsStore.error = options.error ?? '';
}

function queueSync(session: ActiveCallSession) {
	session.sync = session.sync
		.then(() => syncSession(session))
		.catch((error) => {
			if (activeSession === session) void failSession(session, error);
		});
}

async function syncSession(session: ActiveCallSession) {
	if (activeSession !== session) return;
	const group = getChatGroup(session.groupId);
	if (unusableGroup(group)) {
		await disposeSession(session);
		chatCallsStore.dialogOpen = false;
		chatCallsStore.error = 'The call ended because this chat is no longer available';
		return;
	}
	const latest = groupCallCards(session.groupId).find(
		(card) => card.announcement.callId === session.callId
	);
	if (latest?.announcement.status === 'closed') {
		await leaveChatCall({ announce: false });
		return;
	}
	// A message append must not cost an exporter derivation: only a new epoch does.
	if (!group || group.stateBase64 === session.stateBase64) return;
	const stateBefore = group.stateBase64;
	const snapshot = await readGroupCallSnapshot(session.groupId);
	if (activeSession !== session) return;
	const epochChanged = session.epoch !== snapshot.epoch;
	const next = epochChanged ? deriveMaterial(session, snapshot) : null;
	// Install before recording: a commit that lands while the engine still has no key
	// provider must leave the gate unset, or the join ends on a key the group moved past.
	if (next && !(await session.engine.setFrameKey(next.frameKey, next.keyIndex))) return;
	const added = next ? applyMaterial(session, snapshot, next) : false;
	session.stateBase64 = stateBefore;
	if (
		session.started &&
		session.connected &&
		(added || session.reannounceOnConnect) &&
		latest?.announcement.status === 'open'
	) {
		session.reannounceOnConnect = false;
		await announce(session, 'open');
	}
}

function newEngine(session: ActiveCallSession): LiveKitCallEngine {
	return new LiveKitCallEngine({
		onState(state: CallEngineState) {
			if (activeSession !== session) return;
			session.participants = state.participants;
			chatCallsStore.phase = state.phase;
			chatCallsStore.microphoneEnabled = !state.muted;
			chatCallsStore.cameraEnabled = state.cameraEnabled;
			chatCallsStore.participants = state.participants;
		},
		onReconnectTimeout() {
			if (activeSession === session) void failSession(session, 'The call could not reconnect');
		},
		onDisconnected() {
			if (activeSession === session) void leaveChatCall();
		}
	});
}

async function runPendingCall() {
	const pending = pendingCall;
	if (!pending || activeSession || chatCallsStore.busy) return;
	const account = manager.getActive();
	if (!account) throw new Error('You must be logged in to join a call');
	const session: ActiveCallSession = {
		...pending,
		started: pending.kind === 'start',
		accountPubkey: normalizePubKey(account.pubkey),
		deviceTag: deviceTags.get(pending.callId) ?? newCallDeviceTag(),
		engine: undefined as unknown as LiveKitCallEngine,
		pseudonyms: new Map(),
		members: new Set(),
		participants: [],
		connected: false,
		announcedOpen: false,
		reannounceOnConnect: false,
		sync: Promise.resolve()
	};
	deviceTags.set(session.callId, session.deviceTag);
	session.engine = newEngine(session);
	activeSession = session;
	const attempt = ++generation;
	chatCallsStore.busy = true;
	chatCallsStore.error = '';
	chatCallsStore.active = {
		groupId: session.groupId,
		callId: session.callId,
		service: session.service
	};
	chatCallsStore.phase = 'connecting';
	try {
		session.stateBase64 = getChatGroup(session.groupId)?.stateBase64;
		applyMaterial(session, await readGroupCallSnapshot(session.groupId));
		if (session.started) {
			await announce(session, 'open');
			session.announcedOpen = true;
		}
		applyMaterial(session, await readGroupCallSnapshot(session.groupId));
		const grant = await requestToken(session);
		if (activeSession !== session || generation !== attempt) return;
		applyMaterial(session, await readGroupCallSnapshot(session.groupId));
		await session.engine.join({
			...grant,
			frameKey: session.material!.frameKey,
			keyIndex: session.material!.keyIndex,
			microphoneEnabled: chatCallsStore.microphoneEnabled,
			cameraEnabled: chatCallsStore.cameraEnabled
		});
		if (activeSession !== session || generation !== attempt) return;
		session.connected = true;
		await syncSession(session);
		chatCallsStore.busy = false;
	} catch (error) {
		if (activeSession === session && generation === attempt) await failSession(session, error);
	}
}

function pendingFromCard(groupId: string, card: CallCard): PendingCall | null {
	const announcement = card.announcement;
	if (announcement.status !== 'open' || !announcement.identitySecret) return null;
	return {
		kind: 'join',
		groupId,
		callId: announcement.callId,
		service: announcement.service,
		startsAt: announcement.startsAt,
		identitySecret: announcement.identitySecret
	};
}

export async function openChatCall(groupId: string, eventId?: string) {
	await loadGroupCalls(groupId);
	if (activeSession) {
		chatCallsStore.dialogOpen = true;
		return;
	}
	const card = eventId ? groupCallCard(groupId, eventId) : liveCallCard(groupCallCards(groupId));
	pendingCall = (card && pendingFromCard(groupId, card)) ?? {
		kind: 'start',
		groupId,
		callId: newCallId(),
		service: DEFAULT_CALL_SERVICE,
		startsAt: Math.floor(Date.now() / 1000),
		identitySecret: newCallIdentitySecret()
	};
	chatCallsStore.lobby = {
		groupId,
		callId: pendingCall.kind === 'join' ? pendingCall.callId : undefined,
		service: pendingCall.service
	};
	chatCallsStore.error = '';
	chatCallsStore.dialogOpen = true;
}

export function closeChatCallSurface() {
	chatCallsStore.dialogOpen = false;
}

export async function confirmChatCall() {
	await runPendingCall();
}

export async function setChatCallMicrophoneEnabled(enabled: boolean) {
	chatCallsStore.microphoneEnabled = enabled;
	if (activeSession?.connected) await activeSession.engine.setMuted(!enabled);
}

export async function setChatCallCameraEnabled(enabled: boolean) {
	chatCallsStore.cameraEnabled = enabled;
	if (activeSession?.connected) await activeSession.engine.setCameraEnabled(enabled);
}

export function attachChatCallVideo(identity: string, element: HTMLMediaElement) {
	activeSession?.engine.attachVideo(identity, element);
}

export function detachChatCallVideo(element: HTMLMediaElement) {
	activeSession?.engine.detachVideo(element);
}

export function chatCallMemberPubkey(identity: string): string | null {
	if (!activeSession) return null;
	return activeSession.pseudonyms.get(callPseudonymOf(identity)) ?? null;
}

if (browser) {
	$effect.root(() => {
		$effect(() => {
			void chatCallsStore.active?.callId;
			const session = activeSession;
			if (!session) return;
			const group = getChatGroup(session.groupId);
			void group?.stateBase64;
			void group?.messages;
			void group?.status;
			untrack(() => queueSync(session));
		});
	});

	let accountId = manager.getActive()?.id ?? '';
	manager.active$.subscribe((account) => {
		const next = account?.id ?? '';
		if (next === accountId) return;
		accountId = next;
		void leaveChatCall({ announce: false });
		deviceTags.clear();
		for (const key of Object.keys(snapshots)) delete snapshots[key];
	});
}
