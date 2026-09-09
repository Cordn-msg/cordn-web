import { resolve } from '$app/paths';
import { browser } from '$app/environment';
import { nip19 } from 'nostr-tools';
import { normalizePubKey } from '$lib/utils';
import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
import { publicWebOrigin } from '$lib/utils/appOrigin';
import {
	getChatCoordinator,
	getCoordinatorColor,
	getCoordinatorLabel
} from '$lib/services/chatCoordinators.svelte';
import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';

/**
 * Profile-share link building, shared by the chat tab bar's Share action
 * and other share surfaces.
 *
 * Reads reactive stores (coordinator/key-package state); call from `$derived`
 * contexts so changes propagate.
 */

export interface ProfileShareOption {
	label: string;
	value: string;
	color?: string;
}

function toAbsoluteProfileUrl(path: string): string {
	return browser ? new URL(path, publicWebOrigin()).toString() : path;
}

/** Profile link for one coordinator: the default gets the short no-`c=` form. */
function buildProfileSharePath(
	ownerPubkey: string,
	coordinatorKey: string,
	relays: string[]
): string {
	const base = resolve('/p/[identifier]', { identifier: nip19.npubEncode(ownerPubkey) });
	if (normalizePubKey(coordinatorKey) === normalizePubKey(DEFAULT_CHAT_COORDINATOR_PUBKEY)) {
		return base;
	}
	return `${base}?c=${nip19.nprofileEncode({ pubkey: coordinatorKey, relays })}`;
}

/** One share option per published coordinator (default first, short link). */
export function listProfileShareOptions(ownerPubkey: string | undefined): ProfileShareOption[] {
	if (!ownerPubkey) return [];
	const owner = normalizePubKey(ownerPubkey);
	const defaultKey = normalizePubKey(DEFAULT_CHAT_COORDINATOR_PUBKEY);
	const allKeys = listChatKeyPackages(owner).flatMap((kp) =>
		kp.publishedCoordinatorKeys.map(normalizePubKey)
	);
	// ponytail: O(n²) dedupe, n is coordinator count (single digits) — fine here;
	// default coordinator first so its tab yields the short (no `c=`) link.
	const coordinatorKeys = allKeys
		.filter((key, index) => allKeys.indexOf(key) === index)
		.sort((a, b) => {
			const aDefault = a === defaultKey ? 0 : 1;
			const bDefault = b === defaultKey ? 0 : 1;
			return aDefault - bDefault;
		});
	return coordinatorKeys.map((coordinatorKey) => ({
		label: getCoordinatorLabel(coordinatorKey),
		color: getCoordinatorColor({ pubkey: coordinatorKey, color: undefined }),
		value: toAbsoluteProfileUrl(
			buildProfileSharePath(owner, coordinatorKey, getChatCoordinator(coordinatorKey)?.relays ?? [])
		)
	}));
}

/** The link to show first: first shareable coordinator, else the plain npub link. */
export function defaultProfileShareUrl(ownerPubkey: string | undefined): string {
	if (!ownerPubkey) return '';
	const options = listProfileShareOptions(ownerPubkey);
	if (options.length > 0) return options[0].value;
	return toAbsoluteProfileUrl(
		resolve('/p/[identifier]', { identifier: nip19.npubEncode(ownerPubkey) })
	);
}
