import { SvelteSet } from 'svelte/reactivity';
import { addressLoader } from '$lib/services/loaders.svelte';
import { eventStore } from '$lib/services/eventStore';
import { ProfileModel } from 'applesauce-core/models';
import { Metadata } from 'nostr-tools/kinds';
import type { ProfileContent } from 'applesauce-core/helpers';

export type ProfileHints = Record<string, ProfileContent>;

export interface UseProfileHintsOptions {
	/** Relay URLs for addressLoader metadata subscription. Omit to skip addressLoader. */
	relays?: string[];
}

/**
 * Shared Svelte rune that manages profile hint subscriptions for a reactive list of pubkeys.
 *
 * Subscribes to `eventStore.model(ProfileModel, pubkey)` for each unique pubkey and
 * optionally wraps each with `addressLoader` when `relays` are provided.
 *
 */
export function useProfileHints(
	getPubkeys: () => string[],
	opts: UseProfileHintsOptions = {}
): ProfileHints {
	const hints = $state<ProfileHints>({});

	$effect(() => {
		const pubkeys = [...new SvelteSet(getPubkeys())];
		if (pubkeys.length === 0) return;

		const relays = opts.relays ?? [];

		const subscriptions = pubkeys.flatMap((pubkey) => {
			const subs: Array<{ unsubscribe: () => void }> = [];

			subs.push(
				eventStore.model(ProfileModel, pubkey).subscribe((profile) => {
					const next: ProfileContent = {
						name: profile?.name,
						displayName: profile?.display_name,
						nip05: profile?.nip05,
						picture: profile?.picture
					};
					const prev = hints[pubkey];
					if (
						prev?.name === next.name &&
						prev?.displayName === next.displayName &&
						prev?.nip05 === next.nip05 &&
						prev?.picture === next.picture
					) {
						return;
					}
					hints[pubkey] = next;
				})
			);

			if (relays.length > 0) {
				subs.push(
					addressLoader({
						kind: Metadata,
						pubkey,
						relays
					}).subscribe()
				);
			}

			return subs;
		});

		return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
	});

	return hints;
}
