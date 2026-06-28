import { queryClient } from '$lib/query-client';
import { chatQueryKeys } from '$lib/queries/chatQueryKeys';
import { addressLoader } from '$lib/services/loaders.svelte';
import { eventStore } from '$lib/services/eventStore';
import { metadataRelays } from '$lib/services/relay-pool';
import { ProfileModel } from 'applesauce-core/models';
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
export function profileQueryOptions(pubkey: string) {
	const normalizedPubkey = normalizePubKey(pubkey);
	return {
		queryKey: chatQueryKeys.profile(pubkey),
		queryFn: () =>
			new Promise<boolean>((resolve) => {
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

				const done = () => {
					if (settled) return;
					settled = true;
					if (handles.timer) clearTimeout(handles.timer);
					handles.loader?.unsubscribe();
					handles.store?.unsubscribe();
					resolve(true);
				};

				handles.loader = addressLoader({
					kind: Metadata,
					pubkey: normalizedPubkey,
					relays: metadataRelays
				}).subscribe();

				handles.store = eventStore.model(ProfileModel, normalizedPubkey).subscribe((profile) => {
					if (profile) done();
				});

				handles.timer = setTimeout(done, PROFILE_FETCH_TIMEOUT_MS);
			}),
		staleTime: PROFILE_STALE_TIME
	};
}

/** Triggers a deduplicated profile metadata fetch if not already fresh. */
export function ensureProfileLoaded(pubkey: string): void {
	if (!pubkey) return;
	void queryClient.fetchQuery(profileQueryOptions(pubkey));
}
