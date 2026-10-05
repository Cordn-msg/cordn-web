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
import { getEventHash, type UnsignedEvent } from 'nostr-tools';

import { findImetaTag, deriveMediaKey } from '$lib/services/chatMediaCrypto';
import {
	decryptGroupPayloadBase64,
	decryptGroupPayloadWithKeyBase64,
	deriveGroupPayloadKeyBase64
} from '$lib/services/chatGroupPayloadCrypto';
import {
	isGroupDocumentPullUnresolved,
	reconcileMultiDeviceNow
} from '$lib/services/multiDevice.svelte';

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
import { errorMessage, normalizePubKey, safeNormalizePubKey } from '$lib/utils';

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
	systemKind: 'member-added' | 'member-removed' | 'metadata-changed' | 'commit-lost';
	target?: string;
	committer?: string;
	detail?: string;
}

export interface ChatCordnMessageEnvelope extends UnsignedEvent {
	id: string;
}

export interface GroupMessageIngestionTarget {
	/** Group id (StoredChatGroup); optional for bare test targets. */
	id?: string;
	state: ClientState;
	/** Last skipped sibling Commit (spec §10 step 1 fork evidence); carried to
	 *  the persisted record by the caller. */
	skippedSiblingCommit?: { epoch: string; cursor: number };
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
	/** Missed-update evidence (see PersistedChatGroupLike): set on an unopenable
	 *  sealed payload, cleared by a current-epoch decrypt. */
	staleMark?: { cursor: number; unopenableCount: number };
	/** Retained per-epoch payload keys (newest-4 epochs, epoch → base64 key):
	 *  a lagging sender seals under an epoch we already left. */
	formerPayloadKeys?: Record<string, string>;
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

function finalizeCordnMessageEvent(event: UnsignedEvent): ChatCordnMessageEnvelope {
	return {
		...event,
		id: getEventHash(event)
	};
}

function encodeCordnMessageEvent(event: ChatCordnMessageEnvelope): Uint8Array {
	return encoder.encode(JSON.stringify(event));
}

function decodeCordnMessageEvent(bytes: Uint8Array): ChatCordnMessageEnvelope {
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

function decodeAuthenticatedSender(bytes: Uint8Array): string {
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

async function processMessageBase64(params: {
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
 * Apply one sealed message to a throwaway copy of a state (spec §10 fork
 * evidence probes). Reports what the message means to THIS state without
 * touching any stored group: `opened` — the payload unsealed and the MLS
 * message applied/rejected-by-policy cleanly; `epochMoved` — a Commit applied
 * and advanced the epoch; `siblingSkipped` — a Commit from this identity's own
 * shared leaf (the §10 sibling-skip); `thirdParty` — the message is from
 * another leaf, or a Commit that applied (a shared-leaf Commit carries no
 * signal: it can only be skipped here). Used by the step-1 race replay and
 * the step-2 third-party verdict.
 */
export async function probeSealedMessage(params: {
	state: ClientState;
	sealedMsg64: string;
	localStablePubkey: string;
}): Promise<{
	state: ClientState;
	opened: boolean;
	epochMoved: boolean;
	siblingSkipped: boolean;
	thirdParty: boolean;
}> {
	const unopened = {
		state: params.state,
		opened: false,
		epochMoved: false,
		siblingSkipped: false,
		thirdParty: false
	};
	let opaqueMessageBase64: string;
	try {
		opaqueMessageBase64 = (
			await decryptGroupPayloadBase64({
				state: params.state,
				encryptedBase64: params.sealedMsg64
			})
		).opaqueMessageBase64;
	} catch {
		return unopened;
	}
	const epochBefore = params.state.groupContext.epoch;
	let processed: Awaited<ReturnType<typeof processMessageBase64>>;
	try {
		processed = await processMessageBase64({
			state: params.state,
			opaqueMessageBase64,
			callback: (incoming) => {
				const self = safeNormalizePubKey(params.localStablePubkey);
				if (incoming.kind === 'commit' && incoming.senderLeafIndex !== undefined && self) {
					const sender = listGroupMembers(params.state).find(
						(member) => member.leafIndex === incoming.senderLeafIndex
					);
					if (sender && safeNormalizePubKey(sender.stablePubkey) === self) {
						throw new SiblingCommitSkippedError();
					}
				}
				return createAdminAuthorizationCallback({
					state: params.state,
					metadata: getCordnGroupMetadataExtension(params.state)
				})(incoming);
			}
		});
	} catch (error) {
		if (error instanceof SiblingCommitSkippedError) {
			return {
				state: params.state,
				opened: true,
				epochMoved: false,
				siblingSkipped: true,
				thirdParty: false
			};
		}
		return unopened;
	}
	const epochMoved = processed.newState.groupContext.epoch !== epochBefore;
	let thirdParty = epochMoved;
	if (!thirdParty && processed.kind === 'applicationMessage') {
		try {
			thirdParty =
				safeNormalizePubKey(decodeAuthenticatedSender(processed.aad)) !==
				safeNormalizePubKey(params.localStablePubkey);
		} catch {
			thirdParty = false;
		}
	}
	return { state: processed.newState, opened: true, epochMoved, siblingSkipped: false, thirdParty };
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

/**
 * ts-mls secret-tree failure for a message generation the local ratchet has
 * already consumed (and no longer retains). On a shared-leaf multi-device
 * group this is the sibling-divergence signal (spec multi-device §10): the
 * sender's ratchet replica is behind ours. The ts-mls patch embeds the sender
 * leaf and generation (`Desired gen in the past (leaf N, gen G)`).
 */
export function isStaleGenerationIssue(detail: string): boolean {
	return detail.startsWith('Desired gen in the past');
}

/**
 * Sender leaf of a stale-generation failure, or undefined when unattributed.
 * All ts-mls leaf indices share one numbering (treemath `toLeafIndex` is the
 * identity), so this compares directly with `privatePath.leafIndex` and
 * `listGroupMembers(...).leafIndex`. Attribution matters: only OUR OWN leaf's
 * collision is ours to repair (spec §10) — another account's devices colliding
 * is theirs to settle, and a repair from here would only add a commit for
 * everyone (seen live: 7 repair commits in 8 minutes).
 */
export function staleGenerationLeafIndex(detail: string): number | undefined {
	const match = /\(leaf (\d+), gen \d+\)/.exec(detail);
	return match ? Number(match[1]) : undefined;
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

/** Spec multi-device §10 sibling rule: a Commit authored by our own shared
 *  leaf is a sibling device's — the UpdatePath private keys live only on the
 *  committer, so ingesting it would self-remove. Detection is exact in the
 *  shared-leaf model: only our identity occupies our leaf index. Thrown from
 *  the authorization callback (which fires BEFORE the UpdatePath applies) to
 *  skip the Commit instead. */
export function isSiblingCommitMessage(params: {
	kind: string;
	senderStablePubkey: string | undefined;
	localStablePubkey: string | undefined;
}): boolean {
	// safeNormalizePubKey (peer-controlled values): empty never equals empty.
	const sender = safeNormalizePubKey(params.senderStablePubkey ?? '');
	const local = safeNormalizePubKey(params.localStablePubkey ?? '');
	return params.kind === 'commit' && !!sender && !!local && sender === local;
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

export { buildInboundSystemMessage };

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
	const oldAdmins = new Set((oldMeta.adminPubkeys ?? []).map(safeNormalizePubKey).filter(Boolean));
	const newAdmins = new Set((newMeta.adminPubkeys ?? []).map(safeNormalizePubKey).filter(Boolean));
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

	// Plain Set: ingest hot loop, nothing here is observed reactively.
	const oldPubkeys = new Set(oldMembers.map((m) => normalizePubKey(m.stablePubkey)));
	const newPubkeys = new Set(newMembers.map((m) => normalizePubKey(m.stablePubkey)));

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

	// A Commit with no membership/metadata change is still an epoch advance
	// (keys rotation / rekey). Record it at the Commit's cursor: that record is
	// what makes a re-delivered self-echo dedupe via seenCursors instead of
	// re-processing and failing decryption (ownCommitRegression "bug 2").
	if (
		messages.length === 0 &&
		input.oldState.groupContext.epoch !== input.newState.groupContext.epoch
	) {
		messages.push(
			buildInboundSystemMessage(input.cursor, input.createdAt, committer, 'metadata-changed', {
				detail: 'the group keys'
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
function createSystemMessagesFromCommitProposals(input: {
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

/** Sync issues are keyed by cursor everywhere downstream (the info page renders
 *  them with cursor {#each} keys), so at most one issue per cursor may be
 *  stored — a re-fetched cursor that fails again must REPLACE the previous
 *  detail, never append (duplicate keys crash the Svelte render tree).
 *  Replaces the former ad-hoc `some()` guards that only covered 2 of 6 paths. */
function recordSyncIssue(
	group: GroupMessageIngestionTarget,
	issues: StoredChatSyncIssue[],
	issue: StoredChatSyncIssue
) {
	group.syncIssues = group.syncIssues.filter((existing) => existing.cursor !== issue.cursor);
	group.syncIssues.push(issue);
	const passIndex = issues.findIndex((existing) => existing.cursor === issue.cursor);
	if (passIndex === -1) issues.push(issue);
	else issues[passIndex] = issue;
}

// ── Spec §10.6: unseal-failure rescue + bounded hold ────────────────────────
const UNSEAL_STREAK_RESCUE_THRESHOLD = 3;
const RESCUE_COOLDOWN_MS = 30_000;
const unsealStreakByGroup = new Map<string | undefined, number>();
const rescueCooldownByGroup = new Map<string | undefined, number>();
const heldUnopenableByGroup = new Map<string | undefined, { rescued: boolean }>();

/** How many former-epoch payload keys to retain (mirrors ts-mls's own
 *  `retainKeysForEpochs: 4` — beyond that the INNER layer rejects the message
 *  anyway, so keeping outer keys longer buys nothing). */
const RETAINED_PAYLOAD_KEYS = 4;

/** Open with a retained former-epoch key (newest first). Null when no retained
 *  key verifies the payload. */
function decryptWithFormerPayloadKeys(
	group: GroupMessageIngestionTarget,
	encryptedBase64: string
): string | null {
	const held = group.formerPayloadKeys;
	if (!held) return null;
	for (const epoch of Object.keys(held)
		.map(Number)
		.sort((a, b) => b - a)) {
		const opened = decryptGroupPayloadWithKeyBase64(held[epoch.toString()], encryptedBase64);
		if (opened !== null) return opened;
	}
	return null;
}

/** Remember a state's payload key under its epoch (pure copy-on-write, capped).
 *  Called at EVERY point the group leaves an epoch — the ingest ladder AND the
 *  own-commit flows AND document adoption — or a message sealed at the left
 *  epoch is lost the moment the state moves (report-05). */
export async function noteFormerPayloadKey(
	held: Record<string, string> | undefined,
	state: ClientState
): Promise<Record<string, string>> {
	// Bare ingestion test targets carry neither group context nor key schedule;
	// a real ClientState always does. Retention is skipped, never throws, for
	// the former.
	const epochNumber = state?.groupContext?.epoch;
	if (epochNumber === undefined || !state.keySchedule?.exporterSecret) return held ?? {};
	const epoch = epochNumber.toString();
	if (held && epoch in held) return held;
	const keyBase64 = await deriveGroupPayloadKeyBase64(state);
	const next: Record<string, string> = { ...(held ?? {}), [epoch]: keyBase64 };
	const epochs = Object.keys(next)
		.map(Number)
		.sort((a, b) => a - b);
	for (const old of epochs.slice(0, Math.max(0, epochs.length - RETAINED_PAYLOAD_KEYS))) {
		delete next[old.toString()];
	}
	return next;
}

function noteUnsealSuccess(groupId: string | undefined, formerEpoch = false): void {
	unsealStreakByGroup.delete(groupId);
	// Any successful decrypt invalidates a convergence proof — the next
	// unopenable payload deserves a fresh hold window. A FORMER-epoch decrypt
	// (a lagging sender's) proves no such thing and keeps the hold.
	if (!formerEpoch) heldUnopenableByGroup.delete(groupId);
}

function noteUnsealFailure(groupId: string | undefined): void {
	const streak = (unsealStreakByGroup.get(groupId) ?? 0) + 1;
	unsealStreakByGroup.set(groupId, streak);
	if (streak < UNSEAL_STREAK_RESCUE_THRESHOLD) return;
	const last = rescueCooldownByGroup.get(groupId) ?? 0;
	if (Date.now() - last < RESCUE_COOLDOWN_MS) return;
	rescueCooldownByGroup.set(groupId, Date.now());
	runUnsealRescue();
}

/**
 * Spec §10.6 rescue: force a reconcile that bypasses the tip dedup — the heal
 * for a dead tip subscription / a stranded document pull behind a wall of
 * undecryptable messages. When the rescue proves CONVERGENCE (applied no new
 * state), any payload that still fails is permanently unopenable (e.g. a
 * losing-branch commit): its hold is released so the bounded-hold rule can
 * advance past it. A failed rescue keeps the holds — nothing was learned.
 */
function runUnsealRescue(): void {
	void reconcileMultiDeviceNow()
		.then((result) => {
			if (result.status !== 'ok') return;
			const { seeded, fastForwarded, forkResolved } = result.counts;
			if (seeded + fastForwarded + (forkResolved ?? 0) > 0) return; // state moved — keep holding
			for (const [gid] of heldUnopenableByGroup) {
				heldUnopenableByGroup.set(gid, { rescued: true });
			}
		})
		.catch(() => {});
}

/**
 * Spec §10.6 bounded hold: may the cursor advance past a payload that fails
 * to decrypt? True only after a rescue proved convergence AND no document
 * fetch is still failing (spec §8) — then the payload is permanently
 * unopenable and the stream (and the native notification watermark) must not
 * stall on it forever.
 */
function advancePastUnopenablePayload(groupId: string | undefined): boolean {
	const held = heldUnopenableByGroup.get(groupId);
	return (
		held?.rescued === true && (groupId === undefined || !isGroupDocumentPullUnresolved(groupId))
	);
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
	const seenCursors = new Set(group.messages.map((stored) => stored.cursor));
	const seenMessageIds = new Set(group.messages.map((stored) => stored.id));
	const appliedPendingCommitMessages = new Set<string>();
	const rejectedPendingCommitMessages = new Set<string>();
	let removedLocalMember = false;
	let poisoned = false;
	// Fork-MR scenario E: the cursor floor at the first HELD message of this
	// pass. Held messages stay re-fetchable (the coordinator never resends by
	// cursor) — nothing may carry fetchCursor past one until the hold resolves.
	let heldFloor: number | undefined;

	// The epoch we start from is one a lagging sender may still seal under.
	group.formerPayloadKeys = await noteFormerPayloadKey(group.formerPayloadKeys, group.state);

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
		let formerEpoch = false;
		try {
			processableBase64 = (
				await decryptGroupPayloadBase64({
					state: group.state,
					encryptedBase64: message.opaqueMessageBase64
				})
			).opaqueMessageBase64;
		} catch (error) {
			// A sender that has not seen our latest Commit seals under an epoch we
			// already left — OUR OWN adopt-early window and lagging members both
			// look like this (report-05 "disappearing messages"). Open with a
			// retained former-epoch key before calling it unopenable.
			const former = decryptWithFormerPayloadKeys(group, message.opaqueMessageBase64);
			if (former === null) {
				const detail = errorMessage(error);
				// Multi-device (§10.6): the seal hides the epoch, so a device behind a
				// sibling Commit cannot distinguish "ahead of my epoch" from "corrupt"
				// at this layer — the epochAhead gate below never gets to see these.
				// Mirror it: do NOT advance the cursor (leave it at the decrypt
				// frontier so a post-fast-forward re-fetch retries the message once
				// the document state arrives) and dedup the advisory issue per cursor.
				// The hold is BOUNDED though (§10.6): once a rescue proved convergence
				// (no new state) and no fetch is still failing, the payload is
				// permanently unopenable — advance past it so the stream and the native
				// notification watermark cannot stall on it forever. Single-device
				// keeps fail-and-advance: no document rescues it.
				recordSyncIssue(group, issues, {
					cursor: message.cursor,
					createdAt: message.createdAt,
					detail: `Sealed payload decrypt failed: ${detail}`
				});
				noteUnsealFailure(group.id);
				// Missed-update evidence (staircase StaleEpochTest): this device cannot
				// open what the group sends — it may have missed a Commit. Recorded so
				// the outbound gate refuses work staged from the stale view.
				group.staleMark = {
					cursor: group.staleMark?.cursor ?? message.cursor,
					unopenableCount: (group.staleMark?.unopenableCount ?? 0) + 1
				};
				if (params.mdActive && !advancePastUnopenablePayload(group.id)) {
					heldUnopenableByGroup.set(group.id, { rescued: false });
					// Held (spec §10.6): later messages may still be readable in this
					// pass, but the floor keeps this one re-fetchable.
					heldFloor ??= message.cursor;
					continue;
				}
				group.fetchCursor = message.cursor;
				group.lastCursor = Math.max(group.lastCursor, message.cursor);
				continue;
			}
			processableBase64 = former;
			formerEpoch = true;
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
						// Sibling-skip (spec multi-device §10): skips the Commit instead of
						// ingesting (self-remove). See isSiblingCommitMessage.
						if (
							isSiblingCommitMessage({
								kind: incoming.kind,
								senderStablePubkey: sender?.stablePubkey,
								localStablePubkey: params.localStablePubkey
							})
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
				// Fork evidence (spec §10 step 1): a Commit posted from this epoch
				// afterwards LOST the race to this one — the coordinator sequenced the
				// sibling's Commit first. Remembered so `recordCommitRace` can mark the
				// branch `dead` without asking the stream (which can no longer answer).
				group.skippedSiblingCommit = {
					epoch: group.state.groupContext.epoch.toString(),
					cursor: message.cursor
				};
				recordSyncIssue(group, issues, {
					cursor: message.cursor,
					createdAt: message.createdAt,
					detail: error.message
				});
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
						error: errorMessage(synthesisError)
					});
				}
				continue;
			}

			const detail = errorMessage(error);
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
				// coordinator never resends by cursor). recordSyncIssue keeps one
				// issue per cursor across the re-deliveries. BOUNDED (§10.6): once a
				// rescue proved convergence and no fetch is failing, advance past it.
				recordSyncIssue(group, issues, {
					cursor: message.cursor,
					createdAt: message.createdAt,
					detail: `Ahead of local epoch ${localEpoch} → ${envelope!.epoch}; awaiting group-document catch-up`
				});
				noteUnsealFailure(group.id);
				// Same missed-update evidence as an unopenable seal (above).
				group.staleMark = {
					cursor: group.staleMark?.cursor ?? message.cursor,
					unopenableCount: (group.staleMark?.unopenableCount ?? 0) + 1
				};
				if (!advancePastUnopenablePayload(group.id)) {
					heldUnopenableByGroup.set(group.id, { rescued: false });
					// Held: same cursor floor as an unopenable seal (above).
					heldFloor ??= message.cursor;
					continue;
				}
				group.fetchCursor = message.cursor;
				group.lastCursor = Math.max(group.lastCursor, message.cursor);
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
				noteUnsealFailure(group.id);

				recordSyncIssue(group, issues, {
					cursor: message.cursor,
					createdAt: message.createdAt,
					detail
				});

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

		noteUnsealSuccess(group.id, formerEpoch);
		// A message that decrypts AT THE CURRENT EPOCH proves this device is on the
		// group's line (staircase StaleEpochTest: "back to normal"): the
		// missed-update mark goes and commits work again. A former-epoch decrypt
		// (a lagging sender) proves no such thing and keeps the mark.
		if (!formerEpoch) group.staleMark = undefined;

		if (processed.kind === 'newState' && wasMessageRejectedByCallback(processed)) {
			group.fetchCursor = message.cursor;
			group.lastCursor = Math.max(group.lastCursor, message.cursor);
			recordSyncIssue(group, issues, {
				cursor: message.cursor,
				createdAt: message.createdAt,
				detail: createUnauthorizedAdminRejectionDetail({
					groupId: group.metadata?.name ?? 'unknown'
				})
			});
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
			// The epoch we leave is one a lagging sender may still seal under.
			group.formerPayloadKeys = await noteFormerPayloadKey(group.formerPayloadKeys, oldState);
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

	// Scenario E: the cursor floor. clamp after the loop so no late-processed
	// message in this pass moved the cursor past a held one.
	if (heldFloor !== undefined) {
		group.fetchCursor = Math.min(group.fetchCursor, heldFloor - 1);
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
