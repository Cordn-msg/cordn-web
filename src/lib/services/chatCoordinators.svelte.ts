import { browser } from '$app/environment';
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

	const defaultPubkey = targetPubkey
		? normalizePubKey(targetPubkey)
		: (chatCoordinatorsStore.coordinators.find((entry) => entry.isDefault)?.pubkey ??
			sortCoordinators(chatCoordinatorsStore.coordinators)[0]?.pubkey);

	chatCoordinatorsStore.coordinators = chatCoordinatorsStore.coordinators.map((entry) => ({
		...entry,
		isDefault: entry.pubkey === defaultPubkey
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
	const nextIsDefault =
		input.isDefault ?? existing?.isDefault ?? chatCoordinatorsStore.coordinators.length === 0;
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

export function markCoordinatorUsed(pubkey: string) {
	const normalized = normalizePubKey(pubkey);
	chatCoordinatorsStore.coordinators = chatCoordinatorsStore.coordinators.map((entry) =>
		entry.pubkey === normalized ? { ...entry, lastUsedAt: Date.now() } : entry
	);
	saveCoordinators();
}
