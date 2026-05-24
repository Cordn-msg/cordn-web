import { nip19 } from 'nostr-tools';
import type { StoredChatGroup } from '$lib/services/chatGroups.svelte';
import { normalizePubKey } from '$lib/utils';

export type ChatGroupProfileHints = Record<
	string,
	{ name?: string; displayName?: string; nip05?: string }
>;

export const DIRECT_CHAT_NAME_PREFIX = ':direct_chat:';

function getProfileDisplayName(pubkey: string, profileHints?: ChatGroupProfileHints): string {
	const profile = profileHints?.[pubkey];
	const npub = nip19.npubEncode(pubkey);
	return profile?.name || profile?.displayName || profile?.nip05 || `${npub.slice(0, 12)}…`;
}

export function getDirectChatTargetPubkey(group: StoredChatGroup) {
	const name = group.metadata?.name ?? '';
	if (name.startsWith(DIRECT_CHAT_NAME_PREFIX)) {
		const targetPubkey = normalizePubKey(name.slice(DIRECT_CHAT_NAME_PREFIX.length));
		if (targetPubkey) return targetPubkey;
	}

	return '';
}

export function getChatGroupDisplayTitle(input: {
	group: StoredChatGroup;
	activePubkey?: string;
	profileHints?: ChatGroupProfileHints;
	memberPubkeys?: string[];
}) {
	const explicitName = input.group.metadata?.name?.trim() ?? '';
	if (explicitName && !explicitName.startsWith(DIRECT_CHAT_NAME_PREFIX)) return explicitName;

	const activePubkey = input.activePubkey ? normalizePubKey(input.activePubkey) : '';
	const otherMemberPubkeys = [
		...new Set(
			(input.memberPubkeys ?? [])
				.map((pubkey) => normalizePubKey(pubkey))
				.filter((pubkey) => pubkey && pubkey !== activePubkey)
		)
	];

	if (otherMemberPubkeys.length === 1) {
		return getProfileDisplayName(otherMemberPubkeys[0], input.profileHints);
	}

	if (otherMemberPubkeys.length > 1) {
		const visibleNames = otherMemberPubkeys
			.slice(0, 1)
			.map((pubkey) => getProfileDisplayName(pubkey, input.profileHints));
		const remainingCount = otherMemberPubkeys.length - visibleNames.length;
		return remainingCount > 0
			? `${visibleNames.join(', ')} +${remainingCount}`
			: visibleNames.join(', ');
	}

	const targetPubkey = getDirectChatTargetPubkey(input.group);
	if (targetPubkey) {
		return getProfileDisplayName(targetPubkey, input.profileHints);
	}

	return input.group.id || 'Unnamed chat';
}

export function resolveWelcomeDisplayName(input: {
	welcomeName: string;
	profileHints?: ChatGroupProfileHints;
}): string {
	const targetPubkey = getDirectChatTargetPubkeyFromWelcome(input.welcomeName);
	if (targetPubkey) {
		return getProfileDisplayName(targetPubkey, input.profileHints);
	}
	return input.welcomeName || 'New conversation';
}

export function getDirectChatTargetPubkeyFromWelcome(welcomeName: string): string {
	if (welcomeName.startsWith(DIRECT_CHAT_NAME_PREFIX)) {
		const pubkey = welcomeName.slice(DIRECT_CHAT_NAME_PREFIX.length);
		return normalizePubKey(pubkey) ?? '';
	}
	return '';
}
