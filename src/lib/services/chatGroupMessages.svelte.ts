import {
	base64ToBytes,
	bytesToBase64,
	createApplicationMessage,
	encode,
	mlsMessageDecoder,
	mlsMessageEncoder,
	processMessage,
	unsafeTestingAuthenticationService,
	type ClientState,
	type IncomingMessageCallback
} from 'ts-mls';
import { SvelteSet } from 'svelte/reactivity';
import { getEventHash, type UnsignedEvent } from 'nostr-tools';

import {
	createAdminAuthorizationCallback,
	createUnauthorizedAdminRejectionDetail
} from '$lib/services/chatAdminPolicy';
import { getCordnCipherSuite, getCordnGroupMetadataExtension } from '$lib/services/chatMlsUtils';

export interface StoredChatMessage {
	cursor: number;
	createdAt: number;
	direction: 'inbound' | 'outbound';
	sender: string;
	id: string;
	kind: UnsignedEvent['kind'];
	tags: UnsignedEvent['tags'];
	content: string;
}

export interface ChatMessageReplyTarget {
	id: string;
	pubkey: string;
	kind: number;
	content: string;
	tags: string[][];
}

export interface ChatMessageReactionTarget {
	id: string;
	pubkey: string;
	kind: number;
}

export interface ChatMessageEditTarget {
	id: string;
	pubkey: string;
	kind: number;
}

export interface ChatMessageDeleteTarget {
	id: string;
	pubkey: string;
	kind: number;
}

export interface ChatMessageThreadReference {
	rootId: string;
	rootPubkey: string;
	rootKind: number;
	parentId: string;
	parentPubkey: string;
	parentKind: number;
}

export interface ChatMessageReactionReference {
	targetId: string;
	targetPubkey: string;
	targetKind: number;
	reaction: string;
}

export interface ChatMessageEditReference {
	targetId: string;
}

export interface ChatMessageDeleteReference {
	targetId: string;
	targetKind: number;
}

export interface StoredChatSyncIssue {
	cursor: number;
	createdAt: number;
	detail: string;
}

export interface ChatCordnMessageEnvelope extends UnsignedEvent {
	id: string;
}

export interface GroupMessageIngestionTarget {
	state: ClientState;
	metadata?: {
		name: string;
		description?: string;
		icon?: string;
		imageUrl?: string;
		adminPubkeys?: string[];
	};
	lastCursor: number;
	fetchCursor: number;
	messages: StoredChatMessage[];
	syncIssues: StoredChatSyncIssue[];
	status?: 'active' | 'removed';
	removedAtCursor?: number;
}

export interface RawChatGroupMessage {
	cursor: number;
	createdAt: number;
	opaqueMessageBase64: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createUnsignedCordnMessageEvent(params: {
	pubkey: string;
	content: string;
	createdAt?: number;
	kind?: number;
	tags?: string[][];
}): UnsignedEvent {
	return {
		pubkey: params.pubkey,
		content: params.content,
		created_at: params.createdAt ?? Math.floor(Date.now() / 1000),
		kind: params.kind ?? 9,
		tags: params.tags ?? []
	};
}

function findTag(tags: string[][], name: string): string[] | undefined {
	return tags.find((tag) => tag[0] === name);
}

function isFiniteKind(value: string | undefined): value is string {
	if (!value) return false;
	return Number.isFinite(Number(value));
}

export function createReplyMessageTags(target: ChatMessageReplyTarget): string[][] {
	const rootEventTag = findTag(target.tags, 'E');
	const rootKindTag = findTag(target.tags, 'K');
	const rootPubkeyTag = findTag(target.tags, 'P');

	const rootId = rootEventTag?.[1] ?? target.id;
	const rootPubkey = rootPubkeyTag?.[1] ?? rootEventTag?.[3] ?? target.pubkey;
	const rootKind = rootKindTag?.[1] ?? String(target.kind);

	return [
		['E', rootId, '', rootPubkey],
		['K', rootKind],
		['P', rootPubkey],
		['e', target.id, '', target.pubkey],
		['k', String(target.kind)],
		['p', target.pubkey]
	];
}

export function createReactionMessageTags(target: ChatMessageReactionTarget): string[][] {
	return [
		['e', target.id, '', target.pubkey],
		['p', target.pubkey],
		['k', String(target.kind)]
	];
}

export function createEditMessageTags(
	target: ChatMessageEditTarget,
	tags: string[][] = []
): string[][] {
	return [
		['e', target.id, '', target.pubkey],
		['p', target.pubkey],
		['k', String(target.kind)],
		...tags
	];
}

export function createDeleteMessageTags(target: ChatMessageDeleteTarget): string[][] {
	return [
		['e', target.id, '', target.pubkey],
		['k', String(target.kind)]
	];
}

export function getMessageThreadReference(tags: string[][]): ChatMessageThreadReference | null {
	const rootEventTag = findTag(tags, 'E');
	const rootKindTag = findTag(tags, 'K');
	const parentEventTag = findTag(tags, 'e');
	const parentKindTag = findTag(tags, 'k');

	if (!rootEventTag || !rootKindTag || !parentEventTag || !parentKindTag) {
		return null;
	}

	if (!isFiniteKind(rootKindTag[1]) || !isFiniteKind(parentKindTag[1])) {
		return null;
	}

	const rootId = rootEventTag[1];
	const parentId = parentEventTag[1];
	const rootPubkey = findTag(tags, 'P')?.[1] ?? rootEventTag[3] ?? '';
	const parentPubkey = findTag(tags, 'p')?.[1] ?? parentEventTag[3] ?? '';

	if (!rootId || !parentId || !rootPubkey || !parentPubkey) {
		return null;
	}

	return {
		rootId,
		rootPubkey,
		rootKind: Number(rootKindTag[1]),
		parentId,
		parentPubkey,
		parentKind: Number(parentKindTag[1])
	};
}

export function getMessageReactionReference(
	kind: number,
	content: string,
	tags: string[][]
): ChatMessageReactionReference | null {
	if (kind !== 7) {
		return null;
	}

	const eventTag = findTag(tags, 'e');
	const pubkeyTag = findTag(tags, 'p');
	const kindTag = findTag(tags, 'k');
	const reaction = content.trim();

	if (!eventTag?.[1] || !pubkeyTag?.[1] || !kindTag?.[1] || !reaction) {
		return null;
	}

	if (!isFiniteKind(kindTag[1])) {
		return null;
	}

	return {
		targetId: eventTag[1],
		targetPubkey: pubkeyTag[1],
		targetKind: Number(kindTag[1]),
		reaction
	};
}

export function getMessageEditReference(
	kind: number,
	content: string,
	tags: string[][]
): ChatMessageEditReference | null {
	if (kind !== 1010 || !content.trim()) {
		return null;
	}

	const eventTag = findTag(tags, 'e');
	if (!eventTag?.[1]) {
		return null;
	}

	return {
		targetId: eventTag[1]
	};
}

export function getMessageDeleteReference(
	kind: number,
	tags: string[][]
): ChatMessageDeleteReference | null {
	if (kind !== 5) {
		return null;
	}

	const eventTag = findTag(tags, 'e');
	const kindTag = findTag(tags, 'k');
	if (!eventTag?.[1] || !isFiniteKind(kindTag?.[1])) {
		return null;
	}

	return {
		targetId: eventTag[1],
		targetKind: Number(kindTag[1])
	};
}

export function finalizeCordnMessageEvent(event: UnsignedEvent): ChatCordnMessageEnvelope {
	return {
		...event,
		id: getEventHash(event)
	};
}

export function encodeCordnMessageEvent(event: ChatCordnMessageEnvelope): Uint8Array {
	return encoder.encode(JSON.stringify(event));
}

export function decodeCordnMessageEvent(bytes: Uint8Array): ChatCordnMessageEnvelope {
	const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Invalid cordn message envelope');
	}

	const candidate = parsed as Record<string, unknown>;
	if ('sig' in candidate) {
		throw new Error('Cordn message envelope must not include sig');
	}

	if (typeof candidate['id'] !== 'string') {
		throw new Error('Invalid cordn message envelope');
	}

	const unsigned = candidate as UnsignedEvent;
	const id = getEventHash(unsigned);
	if (candidate['id'] !== id) {
		throw new Error('Cordn message envelope id mismatch');
	}

	return { ...unsigned, id };
}

export function encodeAuthenticatedSender(stablePubkey: string): Uint8Array {
	return encoder.encode(stablePubkey);
}

export function decodeAuthenticatedSender(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export async function createApplicationMessageBase64(params: {
	state: ClientState;
	event: Omit<ChatCordnMessageEnvelope, 'id'>;
	authenticatedData?: Uint8Array;
}): Promise<{
	newState: ClientState;
	opaqueMessageBase64: string;
	event: ChatCordnMessageEnvelope;
}> {
	const cipherSuite = await getCordnCipherSuite();
	const event = finalizeCordnMessageEvent(params.event);
	const result = await createApplicationMessage({
		context: { cipherSuite, authService: unsafeTestingAuthenticationService },
		state: params.state,
		message: encodeCordnMessageEvent(event),
		authenticatedData: params.authenticatedData
	});

	return {
		newState: result.newState,
		opaqueMessageBase64: bytesToBase64(encode(mlsMessageEncoder, result.message)),
		event
	};
}

export async function processMessageBase64(params: {
	state: ClientState;
	opaqueMessageBase64: string;
	callback?: IncomingMessageCallback;
}): Promise<Awaited<ReturnType<typeof processMessage>>> {
	const cipherSuite = await getCordnCipherSuite();
	const decoded = mlsMessageDecoder(base64ToBytes(params.opaqueMessageBase64), 0);

	if (!decoded) {
		throw new Error('Invalid MLS message');
	}

	if (decoded[0].wireformat !== 2 && decoded[0].wireformat !== 1) {
		throw new Error('Expected framed MLS message');
	}

	return processMessage({
		context: { cipherSuite, authService: unsafeTestingAuthenticationService },
		state: params.state,
		message: decoded[0],
		callback: params.callback
	});
}

function isFormerEpochIssue(detail: string): boolean {
	return (
		detail === 'Cannot process commit or proposal from former epoch' ||
		detail === 'Cannot process message, epoch too old'
	);
}

function isStaleGenerationIssue(detail: string): boolean {
	return detail === 'Desired gen in the past';
}

function isUndecryptableStaleMessageIssue(detail: string): boolean {
	return detail.startsWith('OperationError: The operation failed');
}

function isRemovedMemberCommitIssue(detail: string): boolean {
	return (
		detail === 'Could not find common ancestor' ||
		detail ===
			'This error should never occur, if you see this please submit a bug report. Message: No overlap between provided private keys and update path'
	);
}

function isRemovedFromGroupState(state: ClientState): boolean {
	return state.groupActiveState?.kind === 'removedFromGroup';
}

function wasMessageRejectedByCallback(result: { kind: 'newState'; actionTaken?: string }): boolean {
	return result.actionTaken === 'reject';
}

export async function ingestChatGroupMessages(params: {
	group: GroupMessageIngestionTarget;
	messages: RawChatGroupMessage[];
	hasPendingEpochOperation?: (opaqueMessageBase64: string) => boolean;
	localStablePubkey?: string;
}): Promise<{
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
	cursorAdvancedTo: number;
	appliedPendingCommitMessages: Set<string>;
	rejectedPendingCommitMessages: Set<string>;
	removedLocalMember: boolean;
}> {
	const { group, messages } = params;
	const received: StoredChatMessage[] = [];
	const issues: StoredChatSyncIssue[] = [];
	const seenCursors = new SvelteSet(group.messages.map((stored) => stored.cursor));
	const seenMessageIds = new SvelteSet(group.messages.map((stored) => stored.id));
	const appliedPendingCommitMessages = new SvelteSet<string>();
	const rejectedPendingCommitMessages = new SvelteSet<string>();
	let removedLocalMember = false;

	for (const message of messages) {
		const isPendingOperationMessage =
			params.hasPendingEpochOperation?.(message.opaqueMessageBase64) ?? false;

		if (isPendingOperationMessage) {
			group.fetchCursor = message.cursor;
			group.lastCursor = Math.max(group.lastCursor, message.cursor);
			appliedPendingCommitMessages.add(message.opaqueMessageBase64);
			continue;
		}

		if (seenCursors.has(message.cursor)) {
			group.fetchCursor = message.cursor;
			group.lastCursor = Math.max(group.lastCursor, message.cursor);
			continue;
		}

		let processed: Awaited<ReturnType<typeof processMessageBase64>>;

		try {
			processed = await processMessageBase64({
				state: group.state,
				opaqueMessageBase64: message.opaqueMessageBase64,
				callback: createAdminAuthorizationCallback({
					state: group.state,
					metadata: group.metadata
				})
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);

			if (
				isFormerEpochIssue(detail) ||
				isStaleGenerationIssue(detail) ||
				isUndecryptableStaleMessageIssue(detail) ||
				isRemovedMemberCommitIssue(detail)
			) {
				group.fetchCursor = message.cursor;
				group.lastCursor = Math.max(group.lastCursor, message.cursor);

				const issue = {
					cursor: message.cursor,
					createdAt: message.createdAt,
					detail
				};
				group.syncIssues.push(issue);
				issues.push(issue);
				continue;
			}

			throw error;
		}

		if (processed.kind === 'newState' && wasMessageRejectedByCallback(processed)) {
			const issue = {
				cursor: message.cursor,
				createdAt: message.createdAt,
				detail: createUnauthorizedAdminRejectionDetail({
					groupId: group.metadata?.name ?? 'unknown'
				})
			};
			group.fetchCursor = message.cursor;
			group.lastCursor = Math.max(group.lastCursor, message.cursor);
			group.syncIssues.push(issue);
			issues.push(issue);
			if (isPendingOperationMessage) {
				rejectedPendingCommitMessages.add(message.opaqueMessageBase64);
			}
			continue;
		}

		group.fetchCursor = message.cursor;
		group.lastCursor = Math.max(group.lastCursor, message.cursor);

		if (processed.kind === 'applicationMessage') {
			group.state = processed.newState;
			group.metadata = getCordnGroupMetadataExtension(processed.newState);
			if (isRemovedFromGroupState(processed.newState)) {
				group.status = 'removed';
				group.removedAtCursor = message.cursor;
				removedLocalMember = true;
			}
			if (processed.aad.length === 0) {
				throw new Error('Cordn application message missing authenticated sender');
			}

			const sender = decodeAuthenticatedSender(processed.aad);
			const event = decodeCordnMessageEvent(processed.message);
			if (event.pubkey !== sender) {
				throw new Error('Cordn message envelope pubkey does not match sender');
			}

			const stored: StoredChatMessage = {
				cursor: message.cursor,
				createdAt: message.createdAt,
				direction: 'inbound',
				sender,
				id: event.id,
				kind: event.kind,
				tags: event.tags,
				content: event.content
			};

			seenCursors.add(message.cursor);

			if (seenMessageIds.has(stored.id)) {
				continue;
			}

			seenMessageIds.add(stored.id);
			group.messages.push(stored);
			received.push(stored);
			continue;
		}

		if (processed.kind === 'newState') {
			group.state = processed.newState;
			group.metadata = getCordnGroupMetadataExtension(processed.newState);
			if (isRemovedFromGroupState(processed.newState)) {
				group.status = 'removed';
				group.removedAtCursor = message.cursor;
				removedLocalMember = true;
			}
			if (isPendingOperationMessage) {
				appliedPendingCommitMessages.add(message.opaqueMessageBase64);
			}
		}
	}

	return {
		received,
		issues,
		cursorAdvancedTo: group.fetchCursor,
		appliedPendingCommitMessages,
		rejectedPendingCommitMessages,
		removedLocalMember
	};
}
