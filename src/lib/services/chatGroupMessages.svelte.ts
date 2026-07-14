import {
	base64ToBytes,
	bytesToBase64,
	createApplicationMessage,
	defaultProposalTypes,
	encode,
	isDefaultProposal,
	mlsMessageDecoder,
	mlsMessageEncoder,
	processMessage,
	unsafeTestingAuthenticationService,
	type ClientState,
	type IncomingMessageCallback,
	type ProposalWithSender
} from 'ts-mls';
import { SvelteSet } from 'svelte/reactivity';
import { getEventHash, type UnsignedEvent } from 'nostr-tools';

import { findImetaTag, deriveMediaKey } from '$lib/services/chatMediaCrypto';
import { decryptGroupPayloadBase64 } from '$lib/services/chatGroupPayloadCrypto';

import { ChatKinds, SYSTEM_MESSAGE_KIND } from '$lib/chat/kinds';
import {
	createAdminAuthorizationCallback,
	createUnauthorizedAdminRejectionDetail,
	listGroupMembers
} from '$lib/services/chatAdminPolicy';
import {
	decodeKeyPackageIdentity,
	getCordnCipherSuite,
	getCordnGroupMetadataExtension,
	getCordnGroupMetadataFromExtensions,
	type CordnGroupMetadata
} from '$lib/services/chatMlsUtils';
import { normalizePubKey } from '$lib/utils';

export interface StoredChatMessage {
	cursor: number;
	createdAt: number;
	direction: 'inbound' | 'outbound';
	sender: string;
	id: string;
	kind: UnsignedEvent['kind'];
	tags: UnsignedEvent['tags'];
	content: string;
	/** For media-bearing messages (`imeta` tag): the per-epoch media key
	 *  (base64) captured at ingest/send time, when the processing state holds
	 *  the correct epoch's exporter secret. Stashed rather than re-derived at
	 *  render time because the exporter secret rotates on commits, so the
	 *  current state can't decrypt media from prior epochs. Derivable from the
	 *  persisted group state, so storing it adds no new trust boundary. */
	mediaKeyBase64?: string;
}

export interface StoredChatSyncIssue {
	cursor: number;
	createdAt: number;
	detail: string;
}

export interface StoredChatSystemMessageData {
	systemKind: 'member-added' | 'member-removed' | 'metadata-changed';
	target?: string;
	committer?: string;
	detail?: string;
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
	status?: 'active' | 'removed' | 'poisoned';
	removedAtCursor?: number;
	poisonedAtCursor?: number;
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
		kind: params.kind ?? ChatKinds.Text,
		tags: params.tags ?? []
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

/**
 * Extract unprotected MLS envelope metadata for diagnostic logging.
 * Returns epoch, contentType, and wireformat without requiring decryption.
 */
function extractMlsEnvelopeMetadata(opaqueMessageBase64: string): {
	wireformat: number;
	epoch?: bigint;
	contentType?: number;
} | null {
	try {
		const decoded = mlsMessageDecoder(base64ToBytes(opaqueMessageBase64), 0);
		if (!decoded) return null;
		const [message] = decoded;
		const result: { wireformat: number; epoch?: bigint; contentType?: number } = {
			wireformat: message.wireformat
		};
		if (message.wireformat === 2 && 'privateMessage' in message) {
			result.epoch = message.privateMessage.epoch;
			result.contentType = message.privateMessage.contentType;
		} else if (message.wireformat === 1 && 'publicMessage' in message) {
			result.epoch = message.publicMessage.content.epoch;
			result.contentType = message.publicMessage.content.contentType;
		}
		return result;
	} catch {
		return null;
	}
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
	// Reverted to narrower match; log full details for diagnosis
	if (detail.startsWith('OperationError: The operation failed')) {
		return true;
	}
	if (detail.startsWith('OperationError')) {
		console.warn('[MLS] OperationError caught but not matching narrow pattern:', detail);
		return false;
	}
	return false;
}

function isRemovedMemberCommitIssue(detail: string): boolean {
	return (
		detail === 'Could not find common ancestor' ||
		detail ===
			'This error should never occur, if you see this please submit a bug report. Message: No overlap between provided private keys and update path'
	);
}

function isRatchetTreeInvariantIssue(detail: string): boolean {
	return detail.includes('non-blank intermediate node must list leaf node in its unmerged_leaves');
}

/**
 * Sentinel for the §10 sibling-skip: an incoming Commit was authored by this
 * identity's own shared leaf (a sibling device). Ingesting it would adopt the
 * sibling's new public keys without the matching private keys → ts-mls
 * self-removes us. Thrown before the UpdatePath applies so the loop skips the
 * Commit (advance cursor, await the group document) instead. Detection is
 * exact: in the shared-leaf model only our identity occupies our leaf index.
 */
class SiblingCommitSkippedError extends Error {
	constructor() {
		super('Skipped sibling commit (own shared leaf); awaiting group-document fast-forward');
		this.name = 'SiblingCommitSkippedError';
	}
}

function isRemovedFromGroupState(state: ClientState): boolean {
	return state.groupActiveState?.kind === 'removedFromGroup';
}

function wasMessageRejectedByCallback(result: { kind: 'newState'; actionTaken?: string }): boolean {
	return result.actionTaken === 'reject';
}

function buildSystemMessageId(
	cursor: number,
	systemKind: StoredChatSystemMessageData['systemKind'],
	target?: string
): string {
	const targetSegment = target ? `:${normalizePubKey(target)}` : '';
	return `system:${cursor}:${systemKind}${targetSegment}`;
}

function buildSystemMessageContent(data: StoredChatSystemMessageData): string {
	return JSON.stringify(data);
}

/**
 * Build an inbound system message (presentation-only) from the varying parts.
 * Centralizes the boilerplate (cursor/createdAt/direction/sender/kind/tags) and
 * derives both id and content from `systemKind` + optional target/detail, so the
 * state-diff path and the sibling-commit-proposal path can't drift apart on id
 * or content parity (fleet presentation consistency, spec §10).
 */
function buildInboundSystemMessage(
	cursor: number,
	createdAt: number,
	committer: string | undefined,
	systemKind: StoredChatSystemMessageData['systemKind'],
	variants: { target?: string; detail?: string } = {}
): StoredChatMessage {
	return {
		cursor,
		createdAt,
		direction: 'inbound',
		sender: committer ?? '',
		id: buildSystemMessageId(cursor, systemKind, variants.target),
		kind: SYSTEM_MESSAGE_KIND,
		tags: [],
		content: buildSystemMessageContent({ systemKind, committer, ...variants })
	};
}

function describeMetadataChanges(
	oldMeta?: CordnGroupMetadata,
	newMeta?: CordnGroupMetadata
): string[] {
	const changes: string[] = [];
	if (!oldMeta || !newMeta) return changes;

	if (oldMeta.name !== newMeta.name) {
		changes.push(`group name to "${newMeta.name}"`);
	}
	if (oldMeta.description !== newMeta.description) {
		changes.push('group description');
	}
	if (oldMeta.icon !== newMeta.icon) {
		changes.push('group icon');
	}
	if (oldMeta.imageUrl !== newMeta.imageUrl) {
		changes.push('group image');
	}
	const oldAdmins = new Set((oldMeta.adminPubkeys ?? []).map(normalizePubKey));
	const newAdmins = new Set((newMeta.adminPubkeys ?? []).map(normalizePubKey));
	if (oldAdmins.size !== newAdmins.size || ![...oldAdmins].every((admin) => newAdmins.has(admin))) {
		changes.push('group admins');
	}

	return changes;
}

export function createSystemMessagesFromStateChange(input: {
	cursor: number;
	createdAt: number;
	oldState: ClientState;
	newState: ClientState;
	oldMetadata?: CordnGroupMetadata;
	newMetadata?: CordnGroupMetadata;
	committerPubkey?: string;
}): StoredChatMessage[] {
	const messages: StoredChatMessage[] = [];
	const committer = input.committerPubkey ? normalizePubKey(input.committerPubkey) : undefined;

	const oldMembers = listGroupMembers(input.oldState);
	const newMembers = listGroupMembers(input.newState);

	const oldPubkeys = new SvelteSet(oldMembers.map((m) => normalizePubKey(m.stablePubkey)));
	const newPubkeys = new SvelteSet(newMembers.map((m) => normalizePubKey(m.stablePubkey)));

	const addedMembers = newMembers.filter((m) => !oldPubkeys.has(normalizePubKey(m.stablePubkey)));
	const removedMembers = oldMembers.filter((m) => !newPubkeys.has(normalizePubKey(m.stablePubkey)));

	for (const member of addedMembers) {
		const target = normalizePubKey(member.stablePubkey);
		messages.push(
			buildInboundSystemMessage(input.cursor, input.createdAt, committer, 'member-added', {
				target
			})
		);
	}

	for (const member of removedMembers) {
		const target = normalizePubKey(member.stablePubkey);
		messages.push(
			buildInboundSystemMessage(input.cursor, input.createdAt, committer, 'member-removed', {
				target
			})
		);
	}

	const metadataChanges = describeMetadataChanges(input.oldMetadata, input.newMetadata);
	if (metadataChanges.length > 0) {
		messages.push(
			buildInboundSystemMessage(input.cursor, input.createdAt, committer, 'metadata-changed', {
				detail: metadataChanges.join(', ')
			})
		);
	}

	return messages;
}

/**
 * Synthesize system messages for a sibling Commit that was skipped (spec §10).
 * The Commit's UpdatePath can't be applied on a sibling device (private keys
 * live only on the committer), so the normal state-diff synthesis never runs.
 * But the Commit's proposals are authenticated data — not path secrets — so
 * reading them is MLS-safe and carries the member/metadata changes. Produces
 * the same message ids + content the committer's own device generates via
 * `createSystemMessagesFromStateChange`, so presentation stays consistent
 * across the fleet without re-ingesting the Commit.
 */
export function createSystemMessagesFromCommitProposals(input: {
	cursor: number;
	createdAt: number;
	proposals: ProposalWithSender[];
	oldState: ClientState;
	oldMetadata?: CordnGroupMetadata;
	committerPubkey?: string;
}): StoredChatMessage[] {
	const messages: StoredChatMessage[] = [];
	const committer = input.committerPubkey ? normalizePubKey(input.committerPubkey) : undefined;

	for (const { proposal } of input.proposals) {
		if (!isDefaultProposal(proposal)) continue;
		switch (proposal.proposalType) {
			case defaultProposalTypes.add: {
				const target = normalizePubKey(decodeKeyPackageIdentity(proposal.add.keyPackage));
				messages.push(
					buildInboundSystemMessage(input.cursor, input.createdAt, committer, 'member-added', {
						target
					})
				);
				break;
			}
			case defaultProposalTypes.remove: {
				const member = listGroupMembers(input.oldState).find(
					(m) => m.leafIndex === proposal.remove.removed
				);
				if (!member) break;
				const target = normalizePubKey(member.stablePubkey);
				messages.push(
					buildInboundSystemMessage(input.cursor, input.createdAt, committer, 'member-removed', {
						target
					})
				);
				break;
			}
			case defaultProposalTypes.group_context_extensions: {
				const newMetadata = getCordnGroupMetadataFromExtensions(
					proposal.groupContextExtensions.extensions
				);
				const changes = describeMetadataChanges(input.oldMetadata, newMetadata);
				if (changes.length === 0) break;
				messages.push(
					buildInboundSystemMessage(input.cursor, input.createdAt, committer, 'metadata-changed', {
						detail: changes.join(', ')
					})
				);
				break;
			}
		}
	}

	return messages;
}

export async function ingestChatGroupMessages(params: {
	group: GroupMessageIngestionTarget;
	messages: RawChatGroupMessage[];
	hasPendingEpochOperation?: (opaqueMessageBase64: string) => boolean;
	localStablePubkey?: string;
	/** MD active: the group document can resolve epochs this device can't derive
	 * (sibling Commits / pre-reconcile). Such messages skip + await instead of
	 * poisoning (§8/§10). */
	mdActive?: boolean;
}): Promise<{
	received: StoredChatMessage[];
	issues: StoredChatSyncIssue[];
	cursorAdvancedTo: number;
	appliedPendingCommitMessages: Set<string>;
	rejectedPendingCommitMessages: Set<string>;
	removedLocalMember: boolean;
	poisoned: boolean;
}> {
	const { group, messages } = params;
	const received: StoredChatMessage[] = [];
	const issues: StoredChatSyncIssue[] = [];
	const seenCursors = new SvelteSet(group.messages.map((stored) => stored.cursor));
	const seenMessageIds = new SvelteSet(group.messages.map((stored) => stored.id));
	const appliedPendingCommitMessages = new SvelteSet<string>();
	const rejectedPendingCommitMessages = new SvelteSet<string>();
	let removedLocalMember = false;
	let poisoned = false;

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

		// Encrypted-only delivery (spec/03): every inbound message is a sealed
		// payload — decrypt to recover the serialized MLS message before
		// processing. Pending own-commits and already-seen cursors short-circuit
		// above, so we only reach here for genuine new inbound. A decrypt failure
		// (wrong epoch / pre-join traffic / corruption) advances the cursor and
		// records an issue rather than poisoning.
		let processableBase64: string;
		try {
			processableBase64 = (
				await decryptGroupPayloadBase64({
					state: group.state,
					encryptedBase64: message.opaqueMessageBase64
				})
			).opaqueMessageBase64;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			group.fetchCursor = message.cursor;
			group.lastCursor = Math.max(group.lastCursor, message.cursor);
			const issue = {
				cursor: message.cursor,
				createdAt: message.createdAt,
				detail: `Sealed payload decrypt failed: ${detail}`
			};
			group.syncIssues.push(issue);
			issues.push(issue);
			continue;
		}

		let processed: Awaited<ReturnType<typeof processMessageBase64>>;
		let commitSenderPubkey: string | undefined;
		let commitProposals: ProposalWithSender[] = [];

		try {
			const adminCallback = createAdminAuthorizationCallback({
				state: group.state,
				metadata: group.metadata
			});
			processed = await processMessageBase64({
				state: group.state,
				opaqueMessageBase64: processableBase64,
				callback: (incoming) => {
					if (incoming.kind === 'commit' && incoming.senderLeafIndex !== undefined) {
						const sender = listGroupMembers(group.state).find(
							(member) => member.leafIndex === incoming.senderLeafIndex
						);
						commitSenderPubkey = sender?.stablePubkey;
						commitProposals = incoming.proposals ?? [];
						// Sibling-skip (spec multi-device §10): a Commit from our own
						// shared leaf cannot be ingested (UpdatePath private keys live
						// only on the committer). The authorization callback fires
						// before the UpdatePath is applied, so throwing here skips the
						// Commit instead of self-removing. Detection is exact in the
						// shared-leaf model: only our identity occupies our leaf index.
						if (
							params.localStablePubkey &&
							sender &&
							normalizePubKey(sender.stablePubkey) === params.localStablePubkey
						) {
							throw new SiblingCommitSkippedError();
						}
					}
					return adminCallback(incoming);
				}
			});
		} catch (error) {
			// Sibling-skip (§10): the callback detected a Commit from our own shared
			// leaf before the UpdatePath applied. Advance the cursor and await the
			// group document; do NOT process (self-removes) or poison.
			if (error instanceof SiblingCommitSkippedError) {
				group.fetchCursor = message.cursor;
				group.lastCursor = Math.max(group.lastCursor, message.cursor);
				const issue = {
					cursor: message.cursor,
					createdAt: message.createdAt,
					detail: error.message
				};
				group.syncIssues.push(issue);
				issues.push(issue);
				// Sibling Commit skipped (§10): the group document owns the MLS state,
				// but the presentation-layer system messages would be lost without the
				// state-diff synthesis (which never ran). Rebuild them from the Commit's
				// proposals — authenticated data, MLS-safe to read without the path.
				// Best-effort: this is presentation-only, so it must never throw — ingest
				// runs inside catchUpGroupFromChain's unguarded replay loop, where a throw
				// would abort gap recovery and silently lose the offline message window.
				try {
					const systemMessages = createSystemMessagesFromCommitProposals({
						cursor: message.cursor,
						createdAt: message.createdAt,
						proposals: commitProposals,
						oldState: group.state,
						oldMetadata: getCordnGroupMetadataExtension(group.state),
						committerPubkey: commitSenderPubkey
					});
					if (systemMessages.length > 0) {
						seenCursors.add(message.cursor);
						for (const systemMessage of systemMessages) {
							if (seenMessageIds.has(systemMessage.id)) continue;
							seenMessageIds.add(systemMessage.id);
							group.messages.push(systemMessage);
							received.push(systemMessage);
						}
					}
				} catch (synthesisError) {
					console.warn('[MLS] sibling-commit system-message synthesis failed', {
						cursor: message.cursor,
						error: synthesisError instanceof Error ? synthesisError.message : String(synthesisError)
					});
				}
				continue;
			}

			const detail = error instanceof Error ? error.message : String(error);
			const envelope = extractMlsEnvelopeMetadata(processableBase64);
			const localEpoch = group.state.groupContext.epoch;
			const epochAhead = envelope?.epoch !== undefined && envelope.epoch > localEpoch;

			console.warn('[MLS] processMessageBase64 error', {
				groupId: group.metadata?.name ?? 'unknown',
				cursor: message.cursor,
				fetchCursor: group.fetchCursor,
				detail,
				envelope,
				localEpoch: localEpoch.toString(),
				epochComparison: epochAhead
					? 'message-ahead'
					: envelope?.epoch !== undefined && envelope.epoch < localEpoch
						? 'message-behind'
						: envelope?.epoch !== undefined
							? 'same-epoch'
							: 'unknown'
			});

			// Multi-device §10/§10.6: an app message at a newer epoch is undecryptable
			// when this device is behind a sibling's Commit (skipped on the stream) —
			// the group document owns that epoch (it carries the leaf private keys the
			// stream cannot). Skip + await fast-forward; never poison for an epoch the
			// document resolves (would fork the device out). The §10.6 gate
			// (awaitMultiDeviceReconciled) reconciles before the stream opens at cold
			// start; this gate is the safety net for the mid-session window (sibling
			// Commits after the gate ran). Poison only when MD is off — no rescue then.
			if (params.mdActive && epochAhead) {
				// Do NOT advance fetchCursor/lastCursor: this message is undecryptable
				// only because the device is behind a sibling's Commit the session
				// document owns. Leaving the cursor at the decrypt frontier lets a
				// chained catch-up (spec §8.5) re-fetch this message once the chain
				// state arrives — advancing here makes it unrecoverable (the
				// coordinator never resends by cursor). Dedup the advisory issue: the
				// same ahead-of-epoch cursor re-delivers on each backlog re-fetch
				// until catch-up resolves it, so one issue per cursor is enough.
				if (!group.syncIssues.some((i) => i.cursor === message.cursor)) {
					const issue = {
						cursor: message.cursor,
						createdAt: message.createdAt,
						detail: `Ahead of local epoch ${localEpoch} → ${envelope!.epoch}; awaiting group-document catch-up`
					};
					group.syncIssues.push(issue);
					issues.push(issue);
				}
				continue;
			}

			if (
				isFormerEpochIssue(detail) ||
				isStaleGenerationIssue(detail) ||
				isUndecryptableStaleMessageIssue(detail) ||
				isRemovedMemberCommitIssue(detail) ||
				isRatchetTreeInvariantIssue(detail)
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

				// Mark group as poisoned on fatal MLS decryption failure
				// (undecryptable stale message that is not a former epoch issue)
				if (
					isUndecryptableStaleMessageIssue(detail) &&
					!isFormerEpochIssue(detail) &&
					group.status !== 'removed'
				) {
					group.status = 'poisoned';
					group.poisonedAtCursor = message.cursor;
					poisoned = true;
				}

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
				content: event.content,
				mediaKeyBase64: findImetaTag(event.tags)
					? bytesToBase64(await deriveMediaKey(group.state))
					: undefined
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
			const oldState = group.state;
			const oldMetadata = getCordnGroupMetadataExtension(oldState);
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

			const systemMessages = createSystemMessagesFromStateChange({
				cursor: message.cursor,
				createdAt: message.createdAt,
				oldState,
				newState: processed.newState,
				oldMetadata,
				newMetadata: group.metadata,
				committerPubkey: commitSenderPubkey
			});

			if (systemMessages.length > 0) {
				seenCursors.add(message.cursor);
				for (const systemMessage of systemMessages) {
					if (seenMessageIds.has(systemMessage.id)) continue;
					seenMessageIds.add(systemMessage.id);
					group.messages.push(systemMessage);
					received.push(systemMessage);
				}
			}
		}
	}

	return {
		received,
		issues,
		cursorAdvancedTo: group.fetchCursor,
		appliedPendingCommitMessages,
		rejectedPendingCommitMessages,
		removedLocalMember,
		poisoned
	};
}
