import { browser } from '$app/environment';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { manager } from '$lib/services/accountManager.svelte';
import type { PendingWelcome } from '$lib/contracts';
import type { IAccount } from 'applesauce-accounts';
import { listChatCoordinators } from '$lib/services/chatCoordinators.svelte';
import { ensureGroupsLoaded, listChatGroups } from '$lib/services/chatGroups.svelte';
import {
	decodeStoredKeyPackage,
	getChatKeyPackage,
	listChatKeyPackages
} from '$lib/services/chatKeyPackages.svelte';
import type { CordnGroupMetadataPreview } from '$lib/services/chatMlsUtils';
import { previewGroupMetadataFromWelcome } from '$lib/services/chatMlsUtils';
import { requireActiveAccount, withCoordinatorClient } from '$lib/services/chatRuntime';
import { normalizePubKey } from '$lib/utils';

const STORAGE_KEY = 'cordn-chat-welcome-notifications';
const SIGNER_READY_RETRY_ATTEMPTS = 3;
const SIGNER_READY_RETRY_DELAY_MS = 500;

export interface WelcomeNotificationEntry {
	id: string;
	coordinatorKey: string;
	kpRef: string;
	at: number;
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
	loading: boolean;
	submittingIds: Record<string, boolean>;
	error: string;
}>({
	entries: [],
	lastFetchedAtByCoordinator: {},
	loading: false,
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

loadWelcomeNotificationsForOwner();

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

export function listKnownCoordinatorKeys(): string[] {
	const keys = new SvelteSet<string>();
	const fromCoordinators = listChatCoordinators();
	const fromGroups = listChatGroups();
	const fromKeyPackages = listChatKeyPackages(manager.getActive()?.pubkey);
	for (const coordinator of fromCoordinators) keys.add(coordinator.pubkey);
	for (const group of fromGroups) keys.add(group.coordinatorKey);
	for (const keyPackage of fromKeyPackages) {
		for (const coordinatorKey of keyPackage.publishedCoordinatorKeys) keys.add(coordinatorKey);
	}
	return [...keys];
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
			if (
				entry.coordinatorKey === normalizedCoordinatorKey &&
				!responseIds.has(entry.id) &&
				(entry.status === 'accepted' || entry.status === 'dismissed')
			) {
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

function isSignerUnavailableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /signer extension missing/i.test(message);
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPendingWelcomesWithSignerRetry(account: IAccount, coordinatorKey: string) {
	for (let attempt = 0; attempt <= SIGNER_READY_RETRY_ATTEMPTS; attempt += 1) {
		try {
			return await withCoordinatorClient(account, coordinatorKey, (client) =>
				client.FetchPendingWelcomes({})
			);
		} catch (error) {
			if (!isSignerUnavailableError(error) || attempt === SIGNER_READY_RETRY_ATTEMPTS) {
				throw error;
			}

			await wait(SIGNER_READY_RETRY_DELAY_MS);
		}
	}

	throw new Error('Failed to fetch welcome notifications');
}

async function resolveWelcomePreview(entry: WelcomeNotificationEntry) {
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

	chatWelcomeNotificationsStore.entries = chatWelcomeNotificationsStore.entries.map((candidate) =>
		candidate.id === entry.id ? { ...candidate, preview } : candidate
	);
	return preview;
}

async function resolveFetchedWelcomePreviews() {
	let updated = false;
	for (const entry of chatWelcomeNotificationsStore.entries) {
		try {
			const preview = await resolveWelcomePreview(entry);
			if (preview !== undefined) updated = true;
		} catch {
			// Ignore preview failures so the welcome remains accept/reject capable.
		}
	}
	if (updated) saveNotifications();
	return chatWelcomeNotificationsStore.entries;
}

export async function fetchWelcomeNotifications(coordinatorKeys?: string[]) {
	if (!coordinatorKeys) {
		await ensureGroupsLoaded();
	}
	const keys = (coordinatorKeys ?? listKnownCoordinatorKeys()).map(normalizePubKey);
	if (keys.length === 0) {
		chatWelcomeNotificationsStore.error = '';
		return;
	}

	chatWelcomeNotificationsStore.loading = true;
	chatWelcomeNotificationsStore.error = '';
	try {
		const account = requireActiveAccount('You must be logged in to fetch welcomes');
		for (const coordinatorKey of keys) {
			try {
				const result = await fetchPendingWelcomesWithSignerRetry(account, coordinatorKey);
				mergeFetchedWelcomes(coordinatorKey, result.welcomes);
			} catch (error) {
				if (isSignerUnavailableError(error)) return;
				console.warn(
					`Failed to fetch welcomes from coordinator ${coordinatorKey}:`,
					error instanceof Error ? error.message : error
				);
			}
		}
		await resolveFetchedWelcomePreviews();
	} catch (error) {
		if (isSignerUnavailableError(error)) {
			return;
		}

		chatWelcomeNotificationsStore.error =
			error instanceof Error ? error.message : 'Failed to fetch welcome notifications';
	} finally {
		chatWelcomeNotificationsStore.loading = false;
	}
}

export function markWelcomeNotificationRead(id: string) {
	chatWelcomeNotificationsStore.entries = chatWelcomeNotificationsStore.entries.map((entry) =>
		entry.id === id && !entry.readAt ? { ...entry, readAt: Date.now() } : entry
	);
	saveNotifications();
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

export function removeWelcomeNotification(id: string) {
	chatWelcomeNotificationsStore.entries = chatWelcomeNotificationsStore.entries.filter(
		(entry) => entry.id !== id
	);
	saveNotifications();
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
