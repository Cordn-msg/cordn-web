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
				let settled = false;
				const done = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					storeSub.unsubscribe();
					loaderSub.unsubscribe();
					resolve(true);
				};

				const loaderSub = addressLoader({
					kind: Metadata,
					pubkey: normalizedPubkey,
					relays: metadataRelays
				}).subscribe();

				const storeSub = eventStore.model(ProfileModel, normalizedPubkey).subscribe((profile) => {
					if (profile) done();
				});

				const timer = setTimeout(done, PROFILE_FETCH_TIMEOUT_MS);
			}),
		staleTime: PROFILE_STALE_TIME
	};
}

/** Triggers a deduplicated profile metadata fetch if not already fresh. */
export function ensureProfileLoaded(pubkey: string): void {
	if (!pubkey) return;
	void queryClient.fetchQuery(profileQueryOptions(pubkey));
}
