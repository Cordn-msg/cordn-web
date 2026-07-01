import { eventStore } from '$lib/services/eventStore';
import { ProfileModel } from 'applesauce-core/models';
import type { ProfileContent } from 'applesauce-core/helpers';

/**
 * Subscribe to a single pubkey's profile into reactive state.
 *
 * Bridges the RxJS observable returned by `eventStore.model()` to Svelte
 * reactivity with an isolated per-call subscription. This avoids the
 * cross-instance leak of the `$profile` auto-subscription on an observable held
 * in a `$derived` (one resolved name would bleed into every other card).
 * Companion to `useProfileHints`, which does the same for a list of pubkeys.
 *
 * Does not fetch — pair with `ensureProfileLoaded` when a metadata fetch is
 * needed. Must be called during component init (it registers an `$effect`);
 * read `current` reactively in templates/deriveds.
 */
export function useProfile(getPubkey: () => string): {
	readonly current: ProfileContent | undefined;
} {
	let profile = $state<ProfileContent | undefined>(undefined);

	$effect(() => {
		const pubkey = getPubkey();
		// Reset on pubkey change so a stale profile never shows for the new key.
		profile = undefined;
		const sub = eventStore.model(ProfileModel, pubkey).subscribe((p) => {
			profile = p;
		});
		return () => sub.unsubscribe();
	});

	return {
		get current() {
			return profile;
		}
	};
}
