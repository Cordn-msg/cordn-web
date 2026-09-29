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
	let boundPubkey = '';
	let sub: { unsubscribe(): void } | undefined;

	const bind = (pubkey: string) => {
		if (pubkey === boundPubkey) return;
		sub?.unsubscribe();
		sub = undefined;
		boundPubkey = pubkey;
		// Reset on pubkey change so a stale profile never shows for the new key.
		profile = undefined;
		// The shared model replays its cached value synchronously on subscribe
		// (ReplaySubject), so a profile seen before resolves during init — before
		// the first paint — instead of leaving a blank/fallback frame behind an
		// effect that only runs after mount.
		sub = eventStore.model(ProfileModel, pubkey).subscribe((p) => {
			profile = p;
		});
	};

	// Synchronous seed for the initial pubkey; the effect rebinds on change and
	// unsubscribes on destroy.
	bind(getPubkey());
	$effect(() => {
		bind(getPubkey());
		return () => {
			sub?.unsubscribe();
			sub = undefined;
			boundPubkey = '';
		};
	});

	return {
		get current() {
			return profile;
		}
	};
}
