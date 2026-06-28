import { browser } from '$app/environment';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { JoinRequest } from '$lib/contracts';
import {
	decodeStoredGroupState,
	ensureGroupsLoaded,
	getChatGroup,
	inviteChatGroupMember,
	listChatGroups
} from '$lib/services/chatGroups.svelte';
import { isGroupAdmin, listGroupMembers } from '$lib/services/chatAdminPolicy';
import {
	isSignerUnavailableError,
	requireActiveAccount,
	withCoordinatorClient,
	withCoordinatorClientRetry
} from '$lib/services/chatRuntime';
import { manager } from '$lib/services/accountManager.svelte';
import { normalizePubKey } from '$lib/utils';
import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';

const STORAGE_KEY = 'cordn-chat-join-requests';
const SENT_STORAGE_KEY = 'cordn-chat-sent-join-requests';

export interface JoinRequestEntry {
	id: string;
	coordinatorKey: string;
	groupId: string;
	requesterStablePubkey: string;
	kpRef: string;
	at: number;
	readAt?: number;
	fetchedAt: number;
	acceptedAt?: number;
	acceptedGroupId?: string;
	dismissedAt?: number;
	status?: 'pending' | 'accepted' | 'dismissed';
}

type PersistedJoinRequests = {
	entries: JoinRequestEntry[];
	lastFetchedAtByGroup: Record<string, number>;
};

export const chatJoinRequestsStore = $state<{
	entries: JoinRequestEntry[];
	lastFetchedAtByGroup: Record<string, number>;
	loading: boolean;
	submittingIds: Record<string, boolean>;
	error: string;
}>({
	entries: [],
	lastFetchedAtByGroup: {},
	loading: false,
	submittingIds: {},
	error: ''
});

let activeNotificationsStorageKey = getJoinRequestsStorageKey();

function makeNotificationId(coordinatorKey: string, groupId: string, request: JoinRequest): string {
	return `${coordinatorKey}:${groupId}:${request.pk}:${request.at}`;
}

function saveJoinRequests() {
	if (!browser) return;
	const payload: PersistedJoinRequests = {
		entries: chatJoinRequestsStore.entries,
		lastFetchedAtByGroup: chatJoinRequestsStore.lastFetchedAtByGroup
	};
	localStorage.setItem(activeNotificationsStorageKey, JSON.stringify(payload));
}

function getJoinRequestsStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

export function loadJoinRequestsForOwner(ownerPubkey?: string) {
	if (!browser) return;
	activeNotificationsStorageKey = getJoinRequestsStorageKey(ownerPubkey);
	try {
		const raw =
			localStorage.getItem(activeNotificationsStorageKey) ??
			(ownerPubkey ? localStorage.getItem(STORAGE_KEY) : null);
		if (!raw) {
			chatJoinRequestsStore.entries = [];
			chatJoinRequestsStore.lastFetchedAtByGroup = {};
			return;
		}
		const parsed = JSON.parse(raw) as PersistedJoinRequests;
		chatJoinRequestsStore.entries = parsed.entries ?? [];
		chatJoinRequestsStore.lastFetchedAtByGroup = parsed.lastFetchedAtByGroup ?? {};
	} catch {
		chatJoinRequestsStore.entries = [];
		chatJoinRequestsStore.lastFetchedAtByGroup = {};
	}
}

export function deleteJoinRequestsForOwner(ownerPubkey: string) {
	if (!browser) return;
	const storageKey = getJoinRequestsStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activeNotificationsStorageKey === storageKey) {
		activeNotificationsStorageKey = getJoinRequestsStorageKey();
	}
	chatJoinRequestsStore.entries = [];
	chatJoinRequestsStore.lastFetchedAtByGroup = {};
}

function mergeFetchedJoinRequests(
	coordinatorKey: string,
	groupId: string,
	requests: JoinRequest[]
) {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	const existingById = new SvelteMap(
		chatJoinRequestsStore.entries.map((entry) => [entry.id, entry])
	);
	const fetchedAt = Date.now();
	const responseIds = new SvelteSet<string>();

	for (const request of requests) {
		const id = makeNotificationId(normalizedCoordinatorKey, groupId, request);
		responseIds.add(id);
		const previous = existingById.get(id);
		let status = previous?.status ?? 'pending';
		if (status === 'pending') {
			const group = getChatGroup(groupId);
			if (group) {
				try {
					const state = decodeStoredGroupState(group);
					if (
						listGroupMembers(state).some(
							(m) => normalizePubKey(m.stablePubkey) === normalizePubKey(request.pk)
						)
					) {
						status = 'accepted';
					}
				} catch {
					// State decoding may fail; leave status as-is.
				}
			}
		}
		existingById.set(id, {
			id,
			coordinatorKey: normalizedCoordinatorKey,
			groupId,
			requesterStablePubkey: request.pk,
			kpRef: request.kp_ref,
			at: request.at,
			fetchedAt,
			readAt: previous?.readAt,
			acceptedAt: previous?.acceptedAt,
			acceptedGroupId: previous?.acceptedGroupId,
			dismissedAt: previous?.dismissedAt,
			status
		});
	}

	const seenIds = new SvelteSet<string>();
	chatJoinRequestsStore.entries = [...existingById.values()]
		.filter((entry) => {
			if (
				entry.coordinatorKey === normalizedCoordinatorKey &&
				entry.groupId === groupId &&
				!responseIds.has(entry.id)
			) {
				return false;
			}
			if (seenIds.has(entry.id)) return false;
			seenIds.add(entry.id);
			return true;
		})
		.sort((a, b) => b.at - a.at);
	chatJoinRequestsStore.lastFetchedAtByGroup = {
		...chatJoinRequestsStore.lastFetchedAtByGroup,
		[`${normalizedCoordinatorKey}:${groupId}`]: fetchedAt
	};
	saveJoinRequests();
}

export async function fetchJoinRequestsForAdminGroups() {
	await ensureGroupsLoaded();

	const account = requireActiveAccount('You must be logged in to fetch join requests');
	const pubkey = normalizePubKey(account.pubkey);

	const adminGroups = listChatGroups().filter((group) =>
		isGroupAdmin({ metadata: group.metadata, stablePubkey: pubkey })
	);

	if (adminGroups.length === 0) {
		chatJoinRequestsStore.error = '';
		return;
	}

	chatJoinRequestsStore.loading = true;
	chatJoinRequestsStore.error = '';

	const groupsByCoordinator = new SvelteMap<string, { gid: string }[]>();
	for (const group of adminGroups) {
		const list = groupsByCoordinator.get(group.coordinatorKey);
		if (list) {
			list.push({ gid: group.id });
		} else {
			groupsByCoordinator.set(group.coordinatorKey, [{ gid: group.id }]);
		}
	}

	try {
		// Fetch concurrently across coordinators (the slow part) but merge
		// sequentially (store mutation) so concurrent merges can't lose updates.
		const outcomes = await Promise.all(
			[...groupsByCoordinator].map(async ([coordinatorKey, groups]) => {
				try {
					// Retire accepted/dismissed join requests on the coordinator via the
					// `consumed` ack (atomic-before-fetch, idempotent). mergeFetchedJoinRequests
					// then drops them locally since the response no longer echoes them.
					const consumed = chatJoinRequestsStore.entries
						.filter(
							(entry) =>
								normalizePubKey(entry.coordinatorKey) === normalizePubKey(coordinatorKey) &&
								(entry.status === 'accepted' || entry.status === 'dismissed')
						)
						.map((entry) => ({
							gid: entry.groupId,
							pk: entry.requesterStablePubkey,
							at: entry.at
						}));
					const result = await withCoordinatorClientRetry(account, coordinatorKey, (client) =>
						client.FetchManyPendingJoinRequests(
							consumed.length > 0 ? { groups, consumed } : { groups }
						)
					);
					const requestsByGroup = new SvelteMap<string, JoinRequest[]>();
					for (const request of result.requests) {
						const list = requestsByGroup.get(request.gid);
						if (list) {
							list.push({ pk: request.pk, kp_ref: request.kp_ref, at: request.at });
						} else {
							requestsByGroup.set(request.gid, [
								{ pk: request.pk, kp_ref: request.kp_ref, at: request.at }
							]);
						}
					}
					return {
						coordinatorKey,
						groups,
						requestsByGroup,
						error: undefined as Error | undefined
					};
				} catch (error) {
					return {
						coordinatorKey,
						groups,
						requestsByGroup: new SvelteMap<string, JoinRequest[]>(),
						error: error as Error
					};
				}
			})
		);
		for (const outcome of outcomes) {
			if (outcome.error) {
				if (isSignerUnavailableError(outcome.error)) return;
				console.warn(
					`Failed to fetch join requests from coordinator ${outcome.coordinatorKey}:`,
					outcome.error instanceof Error ? outcome.error.message : outcome.error
				);
				continue;
			}
			for (const group of outcome.groups) {
				const requests = outcome.requestsByGroup.get(group.gid) ?? [];
				mergeFetchedJoinRequests(outcome.coordinatorKey, group.gid, requests);
			}
		}
	} catch (error) {
		chatJoinRequestsStore.error =
			error instanceof Error ? error.message : 'Failed to fetch join requests';
	} finally {
		chatJoinRequestsStore.loading = false;
	}
}

export async function storeJoinRequest(
	coordinatorKey: string,
	groupId: string,
	keyPackageRef: string
) {
	const account = requireActiveAccount('You must be logged in to request to join a group');

	return withCoordinatorClient(account, coordinatorKey, (client) =>
		client.StoreJoinRequest({
			gid: groupId,
			kp_ref: keyPackageRef
		})
	);
}

export async function acceptJoinRequest(entry: JoinRequestEntry): Promise<string | undefined> {
	const account = requireActiveAccount('You must be logged in to accept join requests');

	setJoinRequestSubmitting(entry.id);

	try {
		const group = await inviteChatGroupMember({
			groupId: entry.groupId,
			identifier: entry.kpRef
		});

		void queryClient.invalidateQueries({
			queryKey: chatQueryKeys.joinRequests(account.pubkey, entry.coordinatorKey)
		});

		markJoinRequestAccepted(entry.id, group.id);
		return group.id;
	} finally {
		clearJoinRequestSubmitting(entry.id);
	}
}

export function markJoinRequestRead(id: string) {
	chatJoinRequestsStore.entries = chatJoinRequestsStore.entries.map((entry) =>
		entry.id === id && !entry.readAt ? { ...entry, readAt: Date.now() } : entry
	);
	saveJoinRequests();
}

export function markAllJoinRequestsRead() {
	const readAt = Date.now();
	chatJoinRequestsStore.entries = chatJoinRequestsStore.entries.map((entry) =>
		entry.readAt ? entry : { ...entry, readAt }
	);
	saveJoinRequests();
}

export function getJoinRequest(id: string): JoinRequestEntry | undefined {
	return chatJoinRequestsStore.entries.find((entry) => entry.id === id);
}

export function removeJoinRequest(id: string) {
	chatJoinRequestsStore.entries = chatJoinRequestsStore.entries.filter((entry) => entry.id !== id);
	saveJoinRequests();
}

export function markJoinRequestAccepted(id: string, groupId: string) {
	chatJoinRequestsStore.entries = chatJoinRequestsStore.entries.map((entry) =>
		entry.id === id
			? { ...entry, status: 'accepted', acceptedAt: Date.now(), acceptedGroupId: groupId }
			: entry
	);
	saveJoinRequests();
}

export function markJoinRequestDismissed(id: string) {
	chatJoinRequestsStore.entries = chatJoinRequestsStore.entries.map((entry) =>
		entry.id === id ? { ...entry, status: 'dismissed', dismissedAt: Date.now() } : entry
	);
	saveJoinRequests();
}

export function setJoinRequestSubmitting(id: string) {
	chatJoinRequestsStore.submittingIds = {
		...chatJoinRequestsStore.submittingIds,
		[id]: true
	};
}

export function clearJoinRequestSubmitting(id: string) {
	chatJoinRequestsStore.submittingIds = {
		...chatJoinRequestsStore.submittingIds,
		[id]: false
	};
}

export function isJoinRequestSubmitting(id: string): boolean {
	return chatJoinRequestsStore.submittingIds[id] === true;
}

export function listJoinRequests(): JoinRequestEntry[] {
	return [...chatJoinRequestsStore.entries]
		.filter((entry) => entry.status !== 'accepted' && entry.status !== 'dismissed')
		.sort((a, b) => b.at - a.at);
}

export function listJoinRequestsForGroup(groupId: string): JoinRequestEntry[] {
	return listJoinRequests().filter((entry) => entry.groupId === groupId);
}

export function listJoinRequestsForCoordinator(coordinatorKey: string): JoinRequestEntry[] {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	return listJoinRequests().filter((entry) => entry.coordinatorKey === normalizedCoordinatorKey);
}

export function getUnreadJoinRequestCount(): number {
	return chatJoinRequestsStore.entries.filter(
		(entry) => !entry.readAt && entry.status !== 'accepted' && entry.status !== 'dismissed'
	).length;
}

function getSentStorageKey(ownerPubkey?: string): string {
	return ownerPubkey ? `${SENT_STORAGE_KEY}:${ownerPubkey}` : SENT_STORAGE_KEY;
}

function loadSentJoinRequestIds(ownerPubkey?: string): string[] {
	if (!browser) return [];
	const raw = localStorage.getItem(getSentStorageKey(ownerPubkey));
	if (!raw) return [];
	try {
		return JSON.parse(raw) as string[];
	} catch {
		return [];
	}
}

export function hasJoinRequestBeenSent(groupId: string): boolean {
	return loadSentJoinRequestIds(manager.getActive()?.pubkey).includes(groupId);
}

export function markJoinRequestSent(groupId: string): void {
	if (!browser) return;
	const ownerPubkey = manager.getActive()?.pubkey;
	if (!ownerPubkey) return;
	const sent = loadSentJoinRequestIds(ownerPubkey);
	if (!sent.includes(groupId)) {
		sent.push(groupId);
		localStorage.setItem(getSentStorageKey(ownerPubkey), JSON.stringify(sent));
	}
}

// Mirror of markJoinRequestSent: clears the advisory "sent" marker so the
// user can re-request if a welcome never arrives or they leave the group.
// Both writes (here + requestSent flip in the route) always travel as a pair.
export function removeSentJoinRequest(groupId: string): void {
	if (!browser) return;
	const ownerPubkey = manager.getActive()?.pubkey;
	if (!ownerPubkey) return;
	const sent = loadSentJoinRequestIds(ownerPubkey);
	const next = sent.filter((id) => id !== groupId);
	if (next.length !== sent.length) {
		localStorage.setItem(getSentStorageKey(ownerPubkey), JSON.stringify(next));
	}
}

export function deleteSentJoinRequestsForOwner(ownerPubkey: string): void {
	if (!browser) return;
	localStorage.removeItem(getSentStorageKey(ownerPubkey));
}
