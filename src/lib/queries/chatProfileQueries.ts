import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { addressLoader, createUserRelayListByPubkeyLoader } from '$lib/services/loaders.svelte';
import { eventStore } from '$lib/services/eventStore';
import { metadataRelays } from '$lib/services/relay-pool';
import { markProfileChecked, restoreCachedProfile } from '$lib/services/profileCache';
import { MailboxesModel, ProfileModel } from 'applesauce-core/models';
import { Metadata } from 'nostr-tools/kinds';
import { normalizePubKey } from '$lib/utils';

const PROFILE_FETCH_TIMEOUT_MS = 10_000;
const PROFILE_STALE_TIME = 5 * 60 * 1000;

/**
 * Deduplicates metadata fetches for a pubkey via Svelte Query.
 *
 * `addressLoader` publishes fetched metadata into `eventStore`, which is the
 * live display source consumed by `ProfileCard` and `useProfileHints`. This
 * query's sole purpose is deduplication — the stale window prevents concurrent
 * and repeated `addressLoader` calls for the same pubkey when multiple
 * components (e.g. several `ProfileCard` instances in one `ChatMessageItem`)
 * request the same profile simultaneously.
 */
function profileQueryOptions(pubkey: string, hints: readonly string[] = []) {
	const normalizedPubkey = normalizePubKey(pubkey);
	const relays = hints.length > 0 ? [...new Set([...hints, ...metadataRelays])] : metadataRelays;
	return {
		queryKey: chatQueryKeys.profile(pubkey, hints),
		queryFn: () =>
			new Promise<boolean>((resolve) => {
				// A restored cache copy may already be in the store. Only the loader's own
				// answer (or an event newer than that copy) may finish this query, or the
				// stale event would satisfy the very refresh meant to replace it.
				const restoredId = eventStore.getReplaceable(Metadata, normalizedPubkey)?.id;
				// Cleanup handles live on a single const holder so `done` (which closes
				// over them) can be declared before the assignments without a TDZ
				// hazard: eventStore.model().subscribe(cb) can invoke cb synchronously
				// when the profile is already cached, calling done() before later
				// declarations are initialized. A const object lets the fields be
				// filled after `done` while keeping the binding const for prefer-const.
				const handles: {
					loader?: { unsubscribe: () => void };
					store?: { unsubscribe: () => void };
					timer?: ReturnType<typeof setTimeout>;
				} = {};
				let settled = false;

				// `checked` means a relay answered. A timeout must not stamp the cache
				// fresh, or one outage would freeze the stale copy for another window.
				const done = (checked: boolean) => {
					if (settled) return;
					settled = true;
					if (handles.timer) clearTimeout(handles.timer);
					handles.loader?.unsubscribe();
					handles.store?.unsubscribe();
					if (checked) markProfileChecked(normalizedPubkey);
					resolve(true);
				};

				handles.loader = addressLoader({
					kind: Metadata,
					pubkey: normalizedPubkey,
					relays
				}).subscribe({
					// Completion is the relay round trip ending, even with nothing new.
					complete: () => done(true),
					error: () => done(false)
				});

				handles.store = eventStore.model(ProfileModel, normalizedPubkey).subscribe(() => {
					if (eventStore.getReplaceable(Metadata, normalizedPubkey)?.id !== restoredId) done(true);
				});

				handles.timer = setTimeout(() => done(false), PROFILE_FETCH_TIMEOUT_MS);
			}),
		staleTime: PROFILE_STALE_TIME
	};
}

/** Triggers a deduplicated profile metadata fetch if not already fresh. */
export function ensureProfileLoaded(pubkey: string, hints: readonly string[] = []): void {
	if (!pubkey) return;
	// A profile persisted by a recent session renders now and costs no relay read;
	// a caller-supplied hint (the profile may only live there) still gets its read.
	const fresh = restoreCachedProfile(pubkey);
	if (fresh && hints.length === 0) return;
	void queryClient.fetchQuery(profileQueryOptions(pubkey, hints));
}

const RELAY_LIST_STALE_TIME = 5 * 60 * 1000;
const RELAY_LIST_FETCH_TIMEOUT_MS = 10_000;

/**
 * Deduplicates kind:10002 (NIP-65) relay-list fetches for a pubkey via Svelte
 * Query, mirroring `profileQueryOptions`. The loader publishes into
 * `eventStore`, which `getUserRelayListFromStore` reads live.
 */
function userRelayListQueryOptions(pubkey: string) {
	const normalizedPubkey = normalizePubKey(pubkey);
	return {
		queryKey: chatQueryKeys.userRelayList(pubkey),
		queryFn: () =>
			new Promise<boolean>((resolve) => {
				const handles: {
					loader?: { unsubscribe: () => void };
					store?: { unsubscribe: () => void };
					timer?: ReturnType<typeof setTimeout>;
				} = {};
				let settled = false;

				const done = () => {
					if (settled) return;
					settled = true;
					if (handles.timer) clearTimeout(handles.timer);
					handles.loader?.unsubscribe();
					handles.store?.unsubscribe();
					resolve(true);
				};

				handles.loader = createUserRelayListByPubkeyLoader(normalizedPubkey).subscribe();

				handles.store = eventStore
					.model(MailboxesModel, normalizedPubkey)
					.subscribe((mailboxes) => {
						if (mailboxes) done();
					});

				handles.timer = setTimeout(done, RELAY_LIST_FETCH_TIMEOUT_MS);
			}),
		staleTime: RELAY_LIST_STALE_TIME
	};
}

/** Triggers a deduplicated NIP-65 relay-list fetch if not already fresh.
 *  Awaiting it lets a read that depends on the outboxes wait for them. */
export async function ensureUserRelayListLoaded(pubkey: string): Promise<void> {
	if (!pubkey) return;
	await queryClient.fetchQuery(userRelayListQueryOptions(pubkey));
}
