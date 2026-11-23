import { browser } from '$app/environment';
import { SvelteMap } from 'svelte/reactivity';
import { SYSTEM_MESSAGE_KIND } from '$lib/chat/kinds';
import { isGroupAdmin } from '$lib/services/chatAdminPolicy';
import {
	ensureGroupsLoaded,
	getChatGroup,
	inviteChatGroupMembers,
	listChatGroupMembers,
	type StoredChatGroup
} from '$lib/services/chatGroups.svelte';
import {
	isJoinRequestSubmitting,
	listJoinRequests,
	markJoinRequestAccepted,
	type JoinRequestEntry
} from '$lib/services/chatJoinRequests.svelte';
import {
	selectAutoApproveTargets,
	type AutoApproveCandidate
} from '$lib/services/chatAutoApprovePolicy';
import { manager } from '$lib/services/accountManager.svelte';
import { normalizePubKey } from '$lib/utils';

/**
 * Per-group "auto-approve new join requests" switches, device-local and never
 * synced (same model as chatGroupMutes): an admin enables it on one device and
 * the value here is `enabledAt`, so requests that predate the switch stay manual.
 *
 * The pass runs wherever join requests are fetched (web tab, Android app), and
 * approves in ONE Commit + one Welcome per group — the same batching a manual
 * multi-select invite uses. It never takes the remove-then-re-add path a manual
 * accept uses, so an existing member is never churned.
 */
const STORAGE_KEY = 'cordn-chat-auto-approve';

const chatAutoApproveStore = $state({ enabled: new SvelteMap<string, number>() });

let activeStorageKey = getStorageKey();

function getStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

function saveEnabled() {
	if (!browser) return;
	localStorage.setItem(
		activeStorageKey,
		JSON.stringify(Object.fromEntries(chatAutoApproveStore.enabled))
	);
}

export function loadChatAutoApproveForOwner(ownerPubkey?: string) {
	if (!browser) return;
	activeStorageKey = getStorageKey(ownerPubkey);
	try {
		const raw = localStorage.getItem(activeStorageKey);
		const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		const enabled = new SvelteMap<string, number>();
		for (const [groupId, enabledAt] of Object.entries(parsed)) {
			if (typeof enabledAt === 'number' && Number.isFinite(enabledAt))
				enabled.set(groupId, enabledAt);
		}
		chatAutoApproveStore.enabled = enabled;
	} catch {
		chatAutoApproveStore.enabled = new SvelteMap();
	}
}

export function deleteChatAutoApproveForOwner(ownerPubkey: string) {
	if (!browser) return;
	const storageKey = getStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activeStorageKey === storageKey) {
		activeStorageKey = getStorageKey();
		chatAutoApproveStore.enabled = new SvelteMap();
	}
}

export function isAutoApproveEnabled(groupId: string): boolean {
	return chatAutoApproveStore.enabled.has(groupId);
}

export function getAutoApproveEnabledAt(groupId: string): number | undefined {
	return chatAutoApproveStore.enabled.get(groupId);
}

/** Enabling stamps `enabledAt`, so a backlog of waiting requests is never swept in. */
export function setAutoApproveEnabled(groupId: string, enabled: boolean) {
	const next = new SvelteMap(chatAutoApproveStore.enabled);
	if (enabled) {
		if (!next.has(groupId)) next.set(groupId, Date.now());
	} else {
		next.delete(groupId);
	}
	chatAutoApproveStore.enabled = next;
	saveEnabled();
}

/** Session-only: a reloaded page gets a fresh budget. Enough to stop a runaway loop. */
const approvalTimes = new Map<string, number[]>();
const attempts = new Map<string, number>();

function countRecentApprovals(groupId: string, now = Date.now()): number {
	const recent = (approvalTimes.get(groupId) ?? []).filter((at) => now - at < 60 * 60 * 1000);
	approvalTimes.set(groupId, recent);
	return recent.length;
}

function rememberApprovals(groupId: string, count: number) {
	if (count <= 0) return;
	const now = Date.now();
	const recent = [...(approvalTimes.get(groupId) ?? []), ...Array<number>(count).fill(now)];
	approvalTimes.set(groupId, recent);
}

/** Pubkeys the loaded message window shows as removed — a kicked member stays manual. */
function listRemovedPubkeys(group: StoredChatGroup): string[] {
	const removed: string[] = [];
	for (const message of group.messages) {
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

let inFlight: Promise<void> | undefined;

/**
 * Approve the join requests every enabled group may approve right now. Fire and
 * forget from the join-request fetch; awaiting the same promise is safe (the
 * pass is single-flight) and lets a caller order notifications after it.
 */
export function autoApproveJoinRequests(): Promise<void> {
	inFlight ??= runAutoApprove().finally(() => {
		inFlight = undefined;
	});
	return inFlight;
}

async function runAutoApprove(): Promise<void> {
	if (!browser) return;
	const account = manager.getActive();
	if (!account) return;
	await ensureGroupsLoaded();
	const activePubkey = normalizePubKey(account.pubkey);

	const byGroup = new Map<string, JoinRequestEntry[]>();
	for (const entry of listJoinRequests()) {
		if (!chatAutoApproveStore.enabled.has(entry.groupId)) continue;
		const list = byGroup.get(entry.groupId) ?? [];
		list.push(entry);
		byGroup.set(entry.groupId, list);
	}

	for (const [groupId, entries] of byGroup) {
		const enabledAt = chatAutoApproveStore.enabled.get(groupId);
		if (enabledAt === undefined) continue;
		const group = getChatGroup(groupId);
		if (!group) continue;
		// Admin-ness is re-checked here even though the switch is admin-only: a
		// local admin list can change between the toggle and this pass.
		if (!isGroupAdmin({ metadata: group.metadata, stablePubkey: activePubkey })) continue;

		const targets = selectAutoApproveTargets(entries.map(toCandidate), {
			isAdmin: true,
			enabledAt,
			members: memberPubkeys(groupId),
			removed: listRemovedPubkeys(group),
			attempts: Object.fromEntries(
				entries
					.filter((entry) => attempts.has(entry.id))
					.map((entry) => [entry.id, attempts.get(entry.id) ?? 0])
			),
			submitting: entries.filter((entry) => isJoinRequestSubmitting(entry.id)).map((e) => e.id),
			recentApprovals: countRecentApprovals(groupId)
		});
		if (targets.length === 0) continue;

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
			let approved = 0;
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
				approved += 1;
			}
			rememberApprovals(groupId, approved);
		} catch (error) {
			// One unhealthy group must not stop the others; the next pass retries.
			console.warn('Auto-approve failed', error instanceof Error ? error.message : error);
		}
	}
}
