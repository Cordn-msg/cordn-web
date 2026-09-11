import { browser } from '$app/environment';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { PendingWelcome } from '$lib/contracts';
import { listKnownCoordinatorKeys } from '$lib/services/chatCoordinators.svelte';
import { ensureGroupsLoaded } from '$lib/services/chatGroups.svelte';
import { decodeStoredKeyPackage, getChatKeyPackage } from '$lib/services/chatKeyPackages.svelte';
import { throwIfCoordinatorInReadBackoff } from '$lib/services/coordinatorHealth.svelte';
import type { CordnGroupMetadataPreview } from '$lib/services/chatMlsUtils';
import { previewGroupMetadataFromWelcome } from '$lib/services/chatMlsUtils';
import {
	assertCoordinatorOperationActive,
	requireActiveAccount,
	withCoordinatorClientRetry
} from '$lib/services/chatRuntime';
import { normalizePubKey } from '$lib/utils';

const STORAGE_KEY = 'cordn-chat-welcome-notifications';

export interface WelcomeNotificationEntry {
	id: string;
	coordinatorKey: string;
	kpRef: string;
	at: number;
	after?: number;
	welcomeBase64: string;
	preview?: CordnGroupMetadataPreview;
	readAt?: number;
	fetchedAt: number;
	acceptedAt?: number;
	acceptedGroupId?: string;
	dismissedAt?: number;
	status?: 'pending' | 'accepted' | 'dismissed';
}

type PersistedWelcomeNotifications = {
	entries: WelcomeNotificationEntry[];
	lastFetchedAtByCoordinator: Record<string, number>;
};

export const chatWelcomeNotificationsStore = $state<{
	entries: WelcomeNotificationEntry[];
	lastFetchedAtByCoordinator: Record<string, number>;
	submittingIds: Record<string, boolean>;
	error: string;
}>({
	entries: [],
	lastFetchedAtByCoordinator: {},
	submittingIds: {},
	error: ''
});

let activeNotificationsStorageKey = getNotificationsStorageKey();

function makeNotificationId(coordinatorKey: string, welcome: PendingWelcome): string {
	return `${coordinatorKey}:${welcome.kp_ref}:${welcome.at}`;
}

function saveNotifications() {
	if (!browser) return;
	const payload: PersistedWelcomeNotifications = {
		entries: chatWelcomeNotificationsStore.entries,
		lastFetchedAtByCoordinator: chatWelcomeNotificationsStore.lastFetchedAtByCoordinator
	};
	localStorage.setItem(activeNotificationsStorageKey, JSON.stringify(payload));
}

function getNotificationsStorageKey(ownerPubkey?: string) {
	return ownerPubkey ? `${STORAGE_KEY}:${ownerPubkey}` : STORAGE_KEY;
}

export function loadWelcomeNotificationsForOwner(ownerPubkey?: string) {
	if (!browser) return;
	activeNotificationsStorageKey = getNotificationsStorageKey(ownerPubkey);
	try {
		const raw =
			localStorage.getItem(activeNotificationsStorageKey) ??
			(ownerPubkey ? localStorage.getItem(STORAGE_KEY) : null);
		if (!raw) {
			chatWelcomeNotificationsStore.entries = [];
			chatWelcomeNotificationsStore.lastFetchedAtByCoordinator = {};
			return;
		}
		const parsed = JSON.parse(raw) as PersistedWelcomeNotifications;
		chatWelcomeNotificationsStore.entries = parsed.entries ?? [];
		chatWelcomeNotificationsStore.lastFetchedAtByCoordinator =
			parsed.lastFetchedAtByCoordinator ?? {};
	} catch {
		chatWelcomeNotificationsStore.entries = [];
		chatWelcomeNotificationsStore.lastFetchedAtByCoordinator = {};
	}
}

export function deleteWelcomeNotificationsForOwner(ownerPubkey: string) {
	if (!browser) return;
	const storageKey = getNotificationsStorageKey(ownerPubkey);
	localStorage.removeItem(storageKey);
	if (activeNotificationsStorageKey === storageKey) {
		activeNotificationsStorageKey = getNotificationsStorageKey();
	}
	chatWelcomeNotificationsStore.entries = [];
	chatWelcomeNotificationsStore.lastFetchedAtByCoordinator = {};
}

export function deleteWelcomeNotificationsForCoordinator(coordinatorKey: string) {
	if (!browser) return;
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	chatWelcomeNotificationsStore.entries = chatWelcomeNotificationsStore.entries.filter(
		(entry) => entry.coordinatorKey !== normalizedCoordinatorKey
	);
	chatWelcomeNotificationsStore.lastFetchedAtByCoordinator = Object.fromEntries(
		Object.entries(chatWelcomeNotificationsStore.lastFetchedAtByCoordinator).filter(
			([key]) => key !== normalizedCoordinatorKey
		)
	);
	saveNotifications();
}

function mergeFetchedWelcomes(coordinatorKey: string, welcomes: PendingWelcome[]) {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	const existingById = new SvelteMap(
		chatWelcomeNotificationsStore.entries.map((entry) => [entry.id, entry])
	);
	const fetchedAt = Date.now();
	const responseIds = new SvelteSet<string>();

	for (const welcome of welcomes) {
		const id = makeNotificationId(normalizedCoordinatorKey, welcome);
		responseIds.add(id);
		const previous = existingById.get(id);
		existingById.set(id, {
			id,
			coordinatorKey: normalizedCoordinatorKey,
			kpRef: welcome.kp_ref,
			at: welcome.at,
			after: welcome.after,
			welcomeBase64: welcome.welcome_64,
			fetchedAt,
			readAt: previous?.readAt,
			acceptedAt: previous?.acceptedAt,
			acceptedGroupId: previous?.acceptedGroupId,
			dismissedAt: previous?.dismissedAt,
			status: previous?.status ?? 'pending'
		});
	}

	const seenIds = new SvelteSet<string>();
	chatWelcomeNotificationsStore.entries = [...existingById.values()]
		.filter((entry) => {
			if (entry.coordinatorKey === normalizedCoordinatorKey && !responseIds.has(entry.id)) {
				return false;
			}
			if (seenIds.has(entry.id)) return false;
			seenIds.add(entry.id);
			return true;
		})
		.sort((a, b) => b.at - a.at);
	chatWelcomeNotificationsStore.lastFetchedAtByCoordinator = {
		...chatWelcomeNotificationsStore.lastFetchedAtByCoordinator,
		[normalizedCoordinatorKey]: fetchedAt
	};
	saveNotifications();
}

async function resolveWelcomePreview(entry: WelcomeNotificationEntry, assertActive: () => void) {
	if (entry.preview) return entry.preview;

	const record = getChatKeyPackage(entry.kpRef);
	if (!record) return undefined;

	const { keyPackage, privateKeyPackage } = decodeStoredKeyPackage(record);
	const preview = await previewGroupMetadataFromWelcome({
		welcomeBase64: entry.welcomeBase64,
		keyPackage,
		privateKeyPackage
	});
	if (!preview) return undefined;
	assertActive();

	chatWelcomeNotificationsStore.entries = chatWelcomeNotificationsStore.entries.map((candidate) =>
		candidate.id === entry.id ? { ...candidate, preview } : candidate
	);
	return preview;
}

async function resolveFetchedWelcomePreviews(assertActive: () => void) {
	let updated = false;
	for (const entry of chatWelcomeNotificationsStore.entries) {
		assertActive();
		try {
			const preview = await resolveWelcomePreview(entry, assertActive);
			if (preview !== undefined) updated = true;
		} catch {
			// Ignore preview failures so the welcome remains accept/reject capable.
		}
	}
	assertActive();
	if (updated) saveNotifications();
	return chatWelcomeNotificationsStore.entries;
}

export async function fetchWelcomeNotifications(
	coordinatorKeys?: string[],
	options: { signal?: AbortSignal; force?: boolean } = {}
) {
	const account = requireActiveAccount('You must be logged in to fetch welcomes');
	const assertActive = () => assertCoordinatorOperationActive(account, options.signal);
	if (!coordinatorKeys) await ensureGroupsLoaded();
	assertActive();
	const keys = (coordinatorKeys ?? listKnownCoordinatorKeys()).map(normalizePubKey);
	await Promise.all(
		keys.map(async (coordinatorKey) => {
			if (!options.force) throwIfCoordinatorInReadBackoff(coordinatorKey);
			// Consumed acknowledgements are idempotent; failed reads retain local rows.
			const consumed = chatWelcomeNotificationsStore.entries
				.filter(
					(entry) =>
						entry.coordinatorKey === coordinatorKey &&
						(entry.status === 'accepted' || entry.status === 'dismissed')
				)
				.map((entry) => ({ kp_ref: entry.kpRef, at: entry.at }));
			const result = await withCoordinatorClientRetry(
				account,
				coordinatorKey,
				(client) => client.FetchPendingWelcomes(consumed.length > 0 ? { consumed } : {}),
				{ signal: options.signal }
			);
			assertActive();
			mergeFetchedWelcomes(coordinatorKey, result.welcomes);
		})
	);
	// Per-coordinator failures propagate to Query; aggregation happens outside this seam.
	await resolveFetchedWelcomePreviews(assertActive);
}

export function markAllWelcomeNotificationsRead() {
	const readAt = Date.now();
	chatWelcomeNotificationsStore.entries = chatWelcomeNotificationsStore.entries.map((entry) =>
		entry.readAt ? entry : { ...entry, readAt }
	);
	saveNotifications();
}

export function getWelcomeNotification(id: string): WelcomeNotificationEntry | undefined {
	return chatWelcomeNotificationsStore.entries.find((entry) => entry.id === id);
}

export function markWelcomeAccepted(id: string, groupId: string) {
	chatWelcomeNotificationsStore.entries = chatWelcomeNotificationsStore.entries.map((entry) =>
		entry.id === id
			? { ...entry, status: 'accepted', acceptedAt: Date.now(), acceptedGroupId: groupId }
			: entry
	);
	saveNotifications();
}

export function markWelcomeDismissed(id: string) {
	chatWelcomeNotificationsStore.entries = chatWelcomeNotificationsStore.entries.map((entry) =>
		entry.id === id ? { ...entry, status: 'dismissed', dismissedAt: Date.now() } : entry
	);
	saveNotifications();
}

export function setWelcomeSubmitting(id: string) {
	chatWelcomeNotificationsStore.submittingIds = {
		...chatWelcomeNotificationsStore.submittingIds,
		[id]: true
	};
}

export function clearWelcomeSubmitting(id: string) {
	chatWelcomeNotificationsStore.submittingIds = {
		...chatWelcomeNotificationsStore.submittingIds,
		[id]: false
	};
}

export function isWelcomeSubmitting(id: string): boolean {
	return chatWelcomeNotificationsStore.submittingIds[id] === true;
}

export function listWelcomeNotifications(): WelcomeNotificationEntry[] {
	return [...chatWelcomeNotificationsStore.entries]
		.filter((entry) => entry.status !== 'accepted' && entry.status !== 'dismissed')
		.sort((a, b) => b.at - a.at);
}

export function listWelcomeNotificationsForCoordinator(
	coordinatorKey: string
): WelcomeNotificationEntry[] {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	return listWelcomeNotifications().filter(
		(entry) => entry.coordinatorKey === normalizedCoordinatorKey
	);
}

export function getUnreadWelcomeNotificationCount(): number {
	return chatWelcomeNotificationsStore.entries.filter(
		(entry) => !entry.readAt && entry.status !== 'accepted' && entry.status !== 'dismissed'
	).length;
}
