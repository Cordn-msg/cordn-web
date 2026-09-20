import { browser } from '$app/environment';
import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { ProfileModel } from 'applesauce-core/models';
import { manager } from '$lib/services/accountManager.svelte';
import { eventStore } from '$lib/services/eventStore';
import { ensureProfileLoaded } from '$lib/queries/chatProfileQueries';
import { listChatGroups } from '$lib/services/chatGroups.svelte';
import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
import { getCoordinatorServerName } from '$lib/services/coordinatorServerInfo.svelte';
import { profileDisplayName } from '$lib/utils/profileName';
import { buildUniqueSlugId, normalizePubKey, pubkeyToHexColor } from '$lib/utils';
import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';

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
	// Re-seed the native background poll set so worker routing tracks relay changes. Dynamic
	// import dodges the nativeBridge→chatCoordinators cycle; seedBackground is a no-op on web and
	// when no account is active yet (cold-start hydration calls through here too).
	void import('$lib/services/nativeBridge').then(({ seedBackground }) => seedBackground());
}

function loadCoordinators() {
	if (!browser) return;
	let firstRun = false;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			firstRun = true;
		} else {
			const parsed = JSON.parse(raw) as PersistedCoordinators;
			chatCoordinatorsStore.coordinators = (parsed.coordinators ?? []).map(migrateCoordinator);
			ensureSingleDefault();
		}
	} catch {
		chatCoordinatorsStore.coordinators = [];
	}

	// First run: seed the default coordinator so new users never have to think
	// about coordinators — it's just there. Not flagged isDefault: that flag is a
	// pure power-user preference (which of several is preselected in create-group),
	// never a functional gate. Seeding only on first run (not on every empty store)
	// means a user who deliberately removes all coordinators isn't re-seeded.
	if (firstRun) {
		upsertChatCoordinator({
			pubkey: DEFAULT_CHAT_COORDINATOR_PUBKEY,
			label: 'Default coordinator'
		});
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

function defaultCoordinatorLabel(pubkey: string): string {
	return `Coordinator ${normalizePubKey(pubkey).slice(0, 8)}`;
}

/**
 * Resolve a display label for a coordinator. Precedence:
 *   1. User-defined stored label (anything other than the auto default)
 *   2. Kind-0 profile name (Nostr identity, fetched via the shared
 *      profile-card query)
 *   3. Server-announced name learned from coordinator responses
 *   4. Auto-derived `Coordinator <short-pubkey>` fallback
 */
export function getCoordinatorLabel(pubkey: string): string {
	const stored = getChatCoordinator(pubkey);
	if (stored && stored.label !== defaultCoordinatorLabel(pubkey)) {
		return stored.label;
	}
	return (
		getCoordinatorProfileName(pubkey) ??
		getCoordinatorServerName(pubkey) ??
		stored?.label ??
		defaultCoordinatorLabel(pubkey)
	);
}

export function getChatCoordinator(pubkey: string): StoredCoordinator | undefined {
	const normalized = normalizePubKey(pubkey);
	return chatCoordinatorsStore.coordinators.find((entry) => entry.pubkey === normalized);
}

/**
 * Kind-0 display names for known coordinators, mirrored from eventStore into a
 * rune map so `getCoordinatorLabel` — a plain function called from
 * non-component code — can read them synchronously like the server-info store.
 * Populated by the browser-only watcher below; account-agnostic (a
 * coordinator's kind-0 profile does not depend on the active account), so no
 * reset on account change. Ephemeral by design, mirroring server info: names
 * are re-fetched each session through the Svelte-Query-deduped profile query.
 */
const coordinatorProfileNames = new SvelteMap<string, string>();

export function getCoordinatorProfileName(coordinatorKey: string): string | undefined {
	return coordinatorProfileNames.get(normalizePubKey(coordinatorKey));
}

const coordinatorProfileSubs = new Map<string, { unsubscribe: () => void }>();

/**
 * Keep profile subscriptions + fetches in sync with the known-coordinator set.
 * Fetch hints prefer the coordinator's own saved relays (they host its kind 0);
 * unsaved coordinators fall back to the default metadata relays inside
 * `ensureProfileLoaded`.
 */
function syncCoordinatorProfileWatches(keys: string[]): void {
	const next = new Set(keys.map(normalizePubKey));
	for (const key of next) {
		if (coordinatorProfileSubs.has(key)) continue;
		coordinatorProfileSubs.set(
			key,
			eventStore.model(ProfileModel, key).subscribe((profile) => {
				const name = profileDisplayName(profile, key);
				if (name) coordinatorProfileNames.set(key, name);
			})
		);
		ensureProfileLoaded(key, getChatCoordinator(key)?.relays ?? []);
	}
	for (const [key, sub] of coordinatorProfileSubs) {
		if (!next.has(key)) {
			sub.unsubscribe();
			coordinatorProfileSubs.delete(key);
			coordinatorProfileNames.delete(key);
		}
	}
}

// Browser-only watcher: reactively tracks the known-coordinator set (saved
// entries, group records, key-package publish targets — the self-healing
// union) and keeps kind-0 subscriptions in sync. Runs detached in an effect
// root at module load; store hydration and later coordinator discovery
// re-trigger it through the reactive reads inside `listKnownCoordinatorKeys`.
if (browser) {
	$effect.root(() => {
		$effect(() => {
			const keys = listKnownCoordinatorKeys();
			untrack(() => syncCoordinatorProfileWatches(keys));
		});
	});
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
	// Undefined label = "not provided": keep the existing label so pubkey-only
	// upserts (profile start-chat, share-link registration) can't clobber a
	// user-set name. Explicit empty/blank resets to the auto default (edit-form
	// clear). This makes upsertChatCoordinator({ pubkey }) idempotent.
	const nextLabel =
		input.label === undefined
			? (existing?.label ?? `Coordinator ${pubkey.slice(0, 8)}`)
			: input.label.trim() || `Coordinator ${pubkey.slice(0, 8)}`;
	const nextIsDefault = input.isDefault ?? existing?.isDefault ?? false;
	const nextRelays = normalizeRelays(input.relays ?? existing?.relays);
	const nextColor = normalizeColor(input.color ?? existing?.color, pubkey);

	if (existing) {
		const updated: StoredCoordinator = {
			...existing,
			label: nextLabel,
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
