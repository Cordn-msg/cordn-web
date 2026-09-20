import { nip19 } from 'nostr-tools';
import { resolve } from '$app/paths';
import { browser } from '$app/environment';
import { normalizePubKey } from '$lib/utils';
import { publicWebOrigin } from '$lib/utils/appOrigin';
import { resolveCoordinatorRelays } from '$lib/services/chatRuntime';

/**
 * Coordinator URL building, shared by the coordinator card/detail share
 * actions and coordinator-page links.
 *
 * Reads reactive stores (coordinator state); call from `$derived` contexts.
 */

/**
 * Route param for a coordinator page: always an nprofile carrying the
 * *effective* relays — saved relays when present, else the client defaults
 * `resolveCoordinatorRelays` falls back to — so links describe what the app
 * actually connects through. `decodeCoordinatorQueryParam` on the route side
 * accepts nprofile, npub, and legacy hex, so old links keep working.
 */
export function coordinatorRouteParam(pubkey: string): string {
	const normalized = normalizePubKey(pubkey);
	return nip19.nprofileEncode({
		pubkey: normalized,
		relays: resolveCoordinatorRelays(normalized)
	});
}

/**
 * Share link for "use this coordinator": lands on the coordinators settings
 * page with the add form prefilled (pubkey + effective relay hints via
 * nprofile). No label param: the receiver resolves the kind-0/server name
 * themselves — the shared label would only risk baking a sender-side
 * auto-default into their stored label.
 */
export function buildCoordinatorShareUrl(pubkey: string): string {
	const path = `${resolve('/chat/coordinators')}?c=${coordinatorRouteParam(pubkey)}`;
	return browser ? new URL(path, publicWebOrigin()).toString() : path;
}
