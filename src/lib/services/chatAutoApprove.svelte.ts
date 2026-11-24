import { browser } from '$app/environment';
import { SvelteSet } from 'svelte/reactivity';
import { SYSTEM_MESSAGE_KIND } from '$lib/chat/kinds';
import { isGroupAdmin } from '$lib/services/chatAdminPolicy';
import {
	ensureGroupsLoaded,
	getChatGroup,
	inviteChatGroupMembers,
	listChatGroupMembers
} from '$lib/services/chatGroups.svelte';
import { getChatStorage } from '$lib/storage/chatStorage';
import {
	clearJoinRequestSubmitting,
	isJoinRequestSubmitting,
	listJoinRequests,
	markJoinRequestAccepted,
	setJoinRequestSubmitting,
	type JoinRequestEntry
} from '$lib/services/chatJoinRequests.svelte';
import {
	selectAutoApproveTargets,
	type AutoApproveCandidate
} from '$lib/services/chatAutoApprovePolicy';
import { manager } from '$lib/services/accountManager.svelte';
import { isMultiDeviceActive } from '$lib/services/multiDevice.svelte';
import { canRunBackgroundWork, isNativePlatform } from '$lib/services/nativeBridge';
import { normalizePubKey, safeNormalizePubKey } from '$lib/utils';

/**
 * Per-group "auto-approve join requests" switches, device-local and never synced
 * (same model as chatGroupMutes). A group is either on or off: turning it on
 * applies to whatever is already waiting as well as to what arrives next.
 *
 * The pass runs wherever join requests are fetched (web tab, Android app), and
 * approves in ONE Commit + one Welcome per group — the same batching a manual
 * multi-select invite uses. It never takes the remove-then-re-add path a manual
 * accept uses, so an existing member is never churned.
 *
 * A pass is scoped to ONE coordinator's requests: a slow or offline coordinator
 * must never delay the approval of another's, so the single-flight is per
 * coordinator rather than one global pass.
 */
const STORAGE_KEY = 'cordn-chat-auto-approve';

const chatAutoApproveStore = $state({ enabled: new SvelteSet<string>() });

let activeStorageKey = getStorageKey();

function getStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

function saveEnabled() {
	if (!browser) return;
	localStorage.setItem(activeStorageKey, JSON.stringify([...chatAutoApproveStore.enabled]));
}

export function loadChatAutoApproveForOwner(ownerPubkey?: string) {
	if (!browser) return;
	activeStorageKey = getStorageKey(ownerPubkey);
	try {
		const raw = localStorage.getItem(activeStorageKey);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		const enabled = new SvelteSet<string>();
		// Legacy shape was `{ gid: enabledAt }`; a gid present there means on.
		if (Array.isArray(parsed)) {
			for (const groupId of parsed) if (typeof groupId === 'string') enabled.add(groupId);
		} else if (parsed && typeof parsed === 'object') {
			for (const groupId of Object.keys(parsed)) enabled.add(groupId);
		}
		chatAutoApproveStore.enabled = enabled;
	} catch {
		chatAutoApproveStore.enabled = new SvelteSet();
	}
}

export function deleteChatAutoApproveForOwner(ownerPubkey: string) {
	if (!browser) return;
	const storageKey = getStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activeStorageKey === storageKey) {
		activeStorageKey = getStorageKey();
		chatAutoApproveStore.enabled = new SvelteSet();
	}
}

export function isAutoApproveEnabled(groupId: string): boolean {
	return chatAutoApproveStore.enabled.has(groupId);
}

/** Turning it on applies to whatever is already waiting: one pass, one Commit. */
export function setAutoApproveEnabled(groupId: string, enabled: boolean) {
	const next = new SvelteSet(chatAutoApproveStore.enabled);
	if (enabled) next.add(groupId);
	else next.delete(groupId);
	chatAutoApproveStore.enabled = next;
	saveEnabled();
}

/** Session-only: a reloaded page gets a fresh budget. Enough to stop a runaway loop. */
const commitTimes = new Map<string, number[]>();
const attempts = new Map<string, number>();

/** Commits already made in this group's rolling hour — one per pass, not per person. */
function countRecentCommits(groupId: string, now = Date.now()): number {
	const recent = (commitTimes.get(groupId) ?? []).filter((at) => now - at < 60 * 60 * 1000);
	commitTimes.set(groupId, recent);
	return recent.length;
}

function rememberCommit(groupId: string) {
	commitTimes.set(groupId, [...(commitTimes.get(groupId) ?? []), Date.now()]);
}

/**
 * Pubkeys the durable history shows as removed — a kicked member stays manual.
 * Read from storage, not the live window: a removal older than the window would
 * otherwise let the next request undo it.
 */
async function listRemovedPubkeys(groupId: string): Promise<string[]> {
	const storage = await getChatStorage();
	const rows = await storage.getGroupMessagesByKinds(groupId, [SYSTEM_MESSAGE_KIND]);
	const removed: string[] = [];
	for (const message of rows) {
		if (message.kind !== SYSTEM_MESSAGE_KIND) continue;
		try {
			const data = JSON.parse(message.content) as { systemKind?: string; target?: string };
			if (data.systemKind === 'member-removed' && data.target) removed.push(data.target);
		} catch {
			// A malformed system row is presentation noise, never a reason to throw.
		}
	}
	return removed;
}

function memberPubkeys(groupId: string): string[] {
	return listChatGroupMembers(groupId).map((member) => member.stablePubkey);
}

function toCandidate(entry: JoinRequestEntry): AutoApproveCandidate {
	// Normalized here: the coordinator's stored pk casing is not guaranteed, and
	// the selector plus the failure/membership checks all compare normalized keys.
	return { id: entry.id, requester: normalizePubKey(entry.requesterStablePubkey), at: entry.at };
}

/** A request this pass actually approved — the caller announces it. */
export interface AutoApprovedJoinRequest {
	groupId: string;
	/** Normalized requester pubkey. */
	requester: string;
}

const inFlight = new Map<string, Promise<AutoApprovedJoinRequest[]>>();

/**
 * Approve the join requests one coordinator's enabled groups may approve right
 * now. Fire and forget from the join-request fetch; awaiting the same promise is
 * safe (the pass is single-flight per coordinator) and lets a caller order
 * notifications after it. A group lives on exactly one coordinator, so scoping
 * the pass there is what keeps a slow coordinator from delaying another's.
 */
export function autoApproveJoinRequests(
	coordinatorKey: string
): Promise<AutoApprovedJoinRequest[]> {
	const key = safeNormalizePubKey(coordinatorKey);
	return key ? runCoordinatorPass(key) : Promise.resolve([]);
}

function runCoordinatorPass(coordinatorKey: string): Promise<AutoApprovedJoinRequest[]> {
	const running = inFlight.get(coordinatorKey);
	if (running) return running;
	const pass = runAutoApprove(coordinatorKey).finally(() => {
		if (inFlight.get(coordinatorKey) === pass) inFlight.delete(coordinatorKey);
	});
	inFlight.set(coordinatorKey, pass);
	return pass;
}

async function runAutoApprove(coordinatorKey: string): Promise<AutoApprovedJoinRequest[]> {
	const approved: AutoApprovedJoinRequest[] = [];
	if (!browser) return approved;
	const account = manager.getActive();
	if (!account) return approved;
	const activePubkey = normalizePubKey(account.pubkey);
	// A backgrounded Commit with multi-device sync on would need a UI-bound signer
	// to re-publish the group document; leave those requests for the next
	// foreground pass instead of committing into a half-updated state.
	if (!canRunBackgroundWork()) return approved;
	if (
		isNativePlatform() &&
		document.visibilityState === 'hidden' &&
		isMultiDeviceActive(activePubkey)
	)
		return approved;
	await ensureGroupsLoaded();

	const byGroup = new Map<string, JoinRequestEntry[]>();
	for (const entry of listJoinRequests()) {
		if (entry.coordinatorKey !== coordinatorKey) continue;
		if (!chatAutoApproveStore.enabled.has(entry.groupId)) continue;
		const list = byGroup.get(entry.groupId) ?? [];
		list.push(entry);
		byGroup.set(entry.groupId, list);
	}

	for (const [groupId, entries] of byGroup) {
		const group = getChatGroup(groupId);
		if (!group) continue;
		// Admin-ness is re-checked here even though the switch is admin-only: a
		// local admin list can change between the toggle and this pass.
		if (!isGroupAdmin({ metadata: group.metadata, stablePubkey: activePubkey })) continue;

		const members = new Set(memberPubkeys(groupId).map(normalizePubKey));
		// Already a member: the request is satisfied, so close it without inviting.
		// The manual accept's remove-then-re-add would churn the member for nothing.
		for (const entry of entries) {
			if (isJoinRequestSubmitting(entry.id)) continue;
			if (members.has(normalizePubKey(entry.requesterStablePubkey)))
				markJoinRequestAccepted(entry.id, groupId);
		}

		let removed: string[];
		try {
			removed = await listRemovedPubkeys(groupId);
		} catch {
			// Without the removal history the guard cannot be honoured: leave the group for a human.
			continue;
		}

		const targets = selectAutoApproveTargets(entries.map(toCandidate), {
			isAdmin: true,
			members: [...members],
			removed,
			attempts: Object.fromEntries(
				entries
					.filter((entry) => attempts.has(entry.id))
					.map((entry) => [entry.id, attempts.get(entry.id) ?? 0])
			),
			submitting: entries.filter((entry) => isJoinRequestSubmitting(entry.id)).map((e) => e.id),
			recentCommits: countRecentCommits(groupId)
		});
		if (targets.length === 0) continue;

		// Mark the batch as being handled so the request cards disable themselves and
		// a manual accept cannot race this Commit into a remove-then-re-add.
		for (const target of targets) setJoinRequestSubmitting(target.id);
		try {
			const result = await inviteChatGroupMembers({
				groupId,
				targets: targets.map((target) => ({
					identifier: target.requester,
					expectedStablePubkey: target.requester
				}))
			});
			const failed = new Set(result.failures.map((failure) => normalizePubKey(failure.identifier)));
			const nowMembers = new Set(memberPubkeys(groupId).map(normalizePubKey));
			for (const target of targets) {
				// A failure means "not added by this Commit": either they are already a
				// member (nothing to do, mark the request handled) or the attempt is
				// counted and retried on the next pass.
				if (failed.has(target.requester)) {
					if (nowMembers.has(target.requester)) markJoinRequestAccepted(target.id, groupId);
					else attempts.set(target.id, (attempts.get(target.id) ?? 0) + 1);
					continue;
				}
				markJoinRequestAccepted(target.id, groupId);
				approved.push({ groupId, requester: target.requester });
			}
			// A duplicate request from someone just approved would stay pending and be
			// announced as "wants to join" right after the approval: close every request
			// whose requester is a member now.
			const handled = new Set(targets.map((target) => target.id));
			for (const entry of entries) {
				if (handled.has(entry.id)) continue;
				if (nowMembers.has(normalizePubKey(entry.requesterStablePubkey)))
					markJoinRequestAccepted(entry.id, groupId);
			}
			// The Commit happened, whatever each target's outcome: it counts against the
			// hourly budget. A thrown batch never reaches here, so it costs no Commit.
			rememberCommit(groupId);
		} catch (error) {
			// The whole batch failed to commit: count an attempt for every target so a
			// persistently broken group cannot retry forever. One unhealthy group must
			// not stop the others; the next pass retries.
			for (const target of targets) attempts.set(target.id, (attempts.get(target.id) ?? 0) + 1);
			console.warn('Auto-approve failed', error instanceof Error ? error.message : error);
		} finally {
			for (const target of targets) clearJoinRequestSubmitting(target.id);
		}
	}
	return approved;
}
