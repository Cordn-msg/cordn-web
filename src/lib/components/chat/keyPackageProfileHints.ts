import { untrack } from 'svelte';

type ProfileHint = { name?: string; displayName?: string; nip05?: string };

export function mergeProfileHint(
	currentHints: Record<string, ProfileHint>,
	pubkey: string,
	next: ProfileHint
) {
	const current = untrack(() => currentHints[pubkey]);
	if (
		current?.name === next.name &&
		current?.displayName === next.displayName &&
		current?.nip05 === next.nip05
	) {
		return currentHints;
	}

	return {
		...untrack(() => currentHints),
		[pubkey]: next
	};
}
