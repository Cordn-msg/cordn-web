import { browser } from '$app/environment';
import { SvelteSet } from 'svelte/reactivity';
import { manager } from '$lib/services/accountManager.svelte';
import { listChatGroups } from '$lib/services/chatGroups.svelte';
import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
import { buildUniqueSlugId, normalizePubKey, pubkeyToHexColor } from '$lib/utils';

const STORAGE_KEY = 'cordn-chat-coordinators';

export interface StoredCoordinator {
	id: string;
	pubkey: string;
	label: string;
	relays: string[];
	isDefault: boolean;
	color?: string;
	createdAt: number;
	lastUsedAt?: number;
}

type PersistedCoordinators = {
	coordinators: StoredCoordinator[];
};

export const chatCoordinatorsStore = $state<{ coordinators: StoredCoordinator[] }>({
	coordinators: []
});

function normalizeRelay(relay: string): string {
	const value = relay.trim();
	if (!value) {
		throw new Error('Relay is required');
	}
	if (!/^wss?:\/\//.test(value)) {
		throw new Error('Relay must start with ws:// or wss://');
	}
	return value;
}

function normalizeRelays(relays?: string[]): string[] {
	const source = relays?.length ? relays : [];
	return [...new Set(source.map(normalizeRelay))];
}

function normalizeColor(color: string | undefined, pubkey: string): string | undefined {
	const value = color?.trim();
	if (!value) return undefined;
	if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
		throw new Error('Color must be a valid 6-digit hex value');
	}
	const normalized = value.toLowerCase();
	return normalized === pubkeyToHexColor(pubkey).toLowerCase() ? undefined : normalized;
}

function sortCoordinators(coordinators: StoredCoordinator[]): StoredCoordinator[] {
	return [...coordinators].sort((a, b) => {
		const aWeight = a.lastUsedAt ?? a.createdAt;
		const bWeight = b.lastUsedAt ?? b.createdAt;
		return bWeight - aWeight;
	});
}

function ensureSingleDefault(targetPubkey?: string) {
	if (chatCoordinatorsStore.coordinators.length === 0) {
		return;
	}

	// Resolve which pubkey should hold the default flag: an explicit target, or
	// the existing default. Never auto-promote — zero defaults is valid, so an
	// auto-stored coordinator (share link, group join, key-package publish) can't
	// steal the default slot. Default is set only deliberately (onboarding
	// bootstrap, manual checkbox, "Set as default").
	const defaultPubkey = targetPubkey
		? normalizePubKey(targetPubkey)
		: (chatCoordinatorsStore.coordinators.find((entry) => entry.isDefault)?.pubkey ?? null);

	chatCoordinatorsStore.coordinators = chatCoordinatorsStore.coordinators.map((entry) => ({
		...entry,
		isDefault: defaultPubkey !== null && entry.pubkey === defaultPubkey
	}));
}

function migrateCoordinator(entry: StoredCoordinator): StoredCoordinator {
	const pubkey = normalizePubKey(entry.pubkey);
	return {
		...entry,
		pubkey,
		relays: normalizeRelays(entry.relays),
		isDefault: Boolean(entry.isDefault),
		color: normalizeColor(entry.color, pubkey)
	};
}

function saveCoordinators() {
	if (!browser) return;
	const payload: PersistedCoordinators = { coordinators: chatCoordinatorsStore.coordinators };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadCoordinators() {
	if (!browser) return;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedCoordinators;
		chatCoordinatorsStore.coordinators = (parsed.coordinators ?? []).map(migrateCoordinator);
		ensureSingleDefault();
	} catch {
		chatCoordinatorsStore.coordinators = [];
	}
}

loadCoordinators();

export function listChatCoordinators(): StoredCoordinator[] {
	return sortCoordinators(chatCoordinatorsStore.coordinators);
}

/**
 * Union of every coordinator pubkey the client has a relationship with:
 * saved profiles, group records, and key-package publish targets. This is the
 * self-healing source for operational queries (available key packages, welcome
 * notifications): correct even if a write path forgets to upsert, since groups
 * and published key packages carry the coordinatorKey directly.
 */
export function listKnownCoordinatorKeys(): string[] {
	const keys = new SvelteSet<string>();
	for (const coordinator of listChatCoordinators()) keys.add(coordinator.pubkey);
	for (const group of listChatGroups()) keys.add(group.coordinatorKey);
	for (const keyPackage of listChatKeyPackages(manager.getActive()?.pubkey)) {
		for (const coordinatorKey of keyPackage.publishedCoordinatorKeys) keys.add(coordinatorKey);
	}
	return [...keys];
}

export function getCoordinatorLabel(pubkey: string): string {
	return getChatCoordinator(pubkey)?.label ?? `Coordinator ${pubkey.slice(0, 8)}`;
}

export function getChatCoordinator(pubkey: string): StoredCoordinator | undefined {
	const normalized = normalizePubKey(pubkey);
	return chatCoordinatorsStore.coordinators.find((entry) => entry.pubkey === normalized);
}

export function getDefaultChatCoordinator(): StoredCoordinator | undefined {
	return chatCoordinatorsStore.coordinators.find((entry) => entry.isDefault);
}

export function getCoordinatorColor(
	coordinator: Pick<StoredCoordinator, 'pubkey' | 'color'>
): string {
	return coordinator.color || pubkeyToHexColor(coordinator.pubkey);
}

export function upsertChatCoordinator(input: {
	pubkey: string;
	label?: string;
	relays?: string[];
	isDefault?: boolean;
	color?: string;
}): StoredCoordinator {
	const pubkey = normalizePubKey(input.pubkey);
	const existing = getChatCoordinator(pubkey);
	const nextLabel = input.label?.trim() || `Coordinator ${pubkey.slice(0, 8)}`;
	const nextIsDefault = input.isDefault ?? existing?.isDefault ?? false;
	const nextRelays = normalizeRelays(input.relays ?? existing?.relays);
	const nextColor = normalizeColor(input.color ?? existing?.color, pubkey);

	if (existing) {
		const updated: StoredCoordinator = {
			...existing,
			label: nextLabel || existing.label,
			relays: nextRelays,
			isDefault: nextIsDefault,
			color: nextColor
		};
		chatCoordinatorsStore.coordinators = chatCoordinatorsStore.coordinators.map((entry) =>
			entry.pubkey === pubkey ? updated : entry
		);
		ensureSingleDefault(updated.isDefault ? pubkey : undefined);
		saveCoordinators();
		return getChatCoordinator(pubkey)!;
	}

	const id = buildUniqueSlugId(
		chatCoordinatorsStore.coordinators.map((entry) => entry.id),
		nextLabel,
		`coordinator-${Date.now()}`
	);

	const created: StoredCoordinator = {
		id,
		pubkey,
		label: nextLabel,
		relays: nextRelays,
		isDefault: nextIsDefault,
		color: nextColor,
		createdAt: Date.now()
	};

	chatCoordinatorsStore.coordinators = [...chatCoordinatorsStore.coordinators, created];
	ensureSingleDefault(created.isDefault ? pubkey : undefined);
	saveCoordinators();
	return getChatCoordinator(pubkey)!;
}

export function removeChatCoordinator(pubkey: string) {
	const normalized = normalizePubKey(pubkey);
	chatCoordinatorsStore.coordinators = chatCoordinatorsStore.coordinators.filter(
		(entry) => entry.pubkey !== normalized
	);
	ensureSingleDefault();
	saveCoordinators();
}

export function setDefaultChatCoordinator(pubkey: string) {
	const normalized = normalizePubKey(pubkey);
	ensureSingleDefault(normalized);
	saveCoordinators();
}

/**
 * Mark a coordinator as recently used, ensuring it is stored first. This is
 * the single relationship-establishment seam: called from group create/join
 * and key-package publish, so any coordinator the user actually interacts with
 * is auto-curated — no manual "save" step. No relay info is available here, so
 * stored relays stay empty and resolveCoordinatorRelays falls back to client
 * defaults (behavior-preserving vs. unsaved). Never grabs the default flag.
 */
export function markCoordinatorUsed(pubkey: string) {
	const normalized = normalizePubKey(pubkey);
	if (!getChatCoordinator(normalized)) {
		upsertChatCoordinator({ pubkey: normalized });
	}
	chatCoordinatorsStore.coordinators = chatCoordinatorsStore.coordinators.map((entry) =>
		entry.pubkey === normalized ? { ...entry, lastUsedAt: Date.now() } : entry
	);
	saveCoordinators();
}

/**
 * Merge coordinators from a backup into the local store (backup import).
 * Existing local entries win by pubkey (non-destructive); backup entries fill
 * gaps. Each imported entry is normalized/migrated the same way a manually
 * added one is.
 */
export function importChatCoordinators(entries: StoredCoordinator[]): void {
	if (!browser) return;
	const existingByPubkey = new Map(
		chatCoordinatorsStore.coordinators.map((entry) => [entry.pubkey, entry])
	);
	for (const raw of entries) {
		const migrated = migrateCoordinator(raw);
		if (!existingByPubkey.has(migrated.pubkey)) {
			existingByPubkey.set(migrated.pubkey, migrated);
		}
	}
	chatCoordinatorsStore.coordinators = [...existingByPubkey.values()];
	ensureSingleDefault();
	saveCoordinators();
}
