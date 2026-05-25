import { browser } from '$app/environment';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { manager } from '$lib/services/accountManager.svelte';
import type { PendingWelcome } from '$lib/contracts';
import { listChatCoordinators } from '$lib/services/chatCoordinators.svelte';
import { listChatGroups } from '$lib/services/chatGroups.svelte';
import {
	decodeStoredKeyPackage,
	getChatKeyPackage,
	listChatKeyPackages
} from '$lib/services/chatKeyPackages.svelte';
import type { CordnGroupMetadataPreview } from '$lib/services/chatMlsUtils';
import { previewGroupMetadataFromWelcome } from '$lib/services/chatMlsUtils';
import { getCoordinatorClient, requireActiveAccount } from '$lib/services/chatRuntime';
import { normalizePubKey } from '$lib/utils';

const STORAGE_KEY = 'cordn-chat-welcome-notifications';

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
	status?: 'pending' | 'accepted';
}

type PersistedWelcomeNotifications = {
	entries: WelcomeNotificationEntry[];
	lastFetchedAtByCoordinator: Record<string, number>;
};

export const chatWelcomeNotificationsStore = $state<{
	entries: WelcomeNotificationEntry[];
	lastFetchedAtByCoordinator: Record<string, number>;
	loading: boolean;
	error: string;
}>({
	entries: [],
	lastFetchedAtByCoordinator: {},
	loading: false,
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
	for (const coordinator of listChatCoordinators()) keys.add(coordinator.pubkey);
	for (const group of listChatGroups()) keys.add(group.coordinatorKey);
	for (const keyPackage of listChatKeyPackages(manager.getActive()?.pubkey)) {
		for (const coordinatorKey of keyPackage.publishedCoordinatorKeys) keys.add(coordinatorKey);
	}
	return [...keys].sort();
}

function mergeFetchedWelcomes(coordinatorKey: string, welcomes: PendingWelcome[]) {
	const normalizedCoordinatorKey = normalizePubKey(coordinatorKey);
	const existingById = new SvelteMap(
		chatWelcomeNotificationsStore.entries.map((entry) => [entry.id, entry])
	);
	const fetchedAt = Date.now();

	for (const welcome of welcomes) {
		const id = makeNotificationId(normalizedCoordinatorKey, welcome);
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
			status: previous?.status ?? 'pending'
		});
	}

	chatWelcomeNotificationsStore.entries = [...existingById.values()].sort((a, b) => b.at - a.at);
	chatWelcomeNotificationsStore.lastFetchedAtByCoordinator = {
		...chatWelcomeNotificationsStore.lastFetchedAtByCoordinator,
		[normalizedCoordinatorKey]: fetchedAt
	};
	saveNotifications();
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
	saveNotifications();
	return preview;
}

async function resolveFetchedWelcomePreviews() {
	for (const entry of chatWelcomeNotificationsStore.entries) {
		try {
			await resolveWelcomePreview(entry);
		} catch {
			// Ignore preview failures so the welcome remains accept/reject capable.
		}
	}
	return chatWelcomeNotificationsStore.entries;
}

export async function fetchWelcomeNotifications(coordinatorKeys?: string[]) {
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
			const client = getCoordinatorClient(account, coordinatorKey);
			const result = await client.FetchPendingWelcomes({});
			mergeFetchedWelcomes(coordinatorKey, result.welcomes);
		}
		await resolveFetchedWelcomePreviews();
	} catch (error) {
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

export function listWelcomeNotifications(): WelcomeNotificationEntry[] {
	return [...chatWelcomeNotificationsStore.entries].sort((a, b) => b.at - a.at);
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
	return chatWelcomeNotificationsStore.entries.filter((entry) => !entry.readAt).length;
}
