import { nip19 } from 'nostr-tools';
import type { StoredChatGroup } from '$lib/services/chatGroups.svelte';
import { normalizePubKey } from '$lib/utils';
import type { ProfileContent } from 'applesauce-core/helpers';

export type ChatGroupProfileHints = Record<string, ProfileContent>;

export const DIRECT_CHAT_NAME_PREFIX = ':direct_chat:';

export function getProfileDisplayName(
	pubkey: string,
	profileHints?: ChatGroupProfileHints
): string {
	const profile = profileHints?.[pubkey];
	const npub = nip19.npubEncode(pubkey);
	return profile?.name || profile?.displayName || profile?.nip05 || `${npub.slice(0, 12)}…`;
}

export function getGroupActivityAt(group: StoredChatGroup): number {
	return Math.max(group.createdAt, group.messages.at(-1)?.createdAt ?? 0);
}

export function getDirectChatTargetPubkey(group: StoredChatGroup) {
	const name = group.metadata?.name ?? '';
	if (name.startsWith(DIRECT_CHAT_NAME_PREFIX)) {
		const targetPubkey = normalizePubKey(name.slice(DIRECT_CHAT_NAME_PREFIX.length));
		if (targetPubkey) return targetPubkey;
	}

	return '';
}

function dedupeOtherMemberPubkeys(memberPubkeys: string[], activePubkey: string): string[] {
	const normalizedActive = activePubkey ? normalizePubKey(activePubkey) : '';
	return [
		...new Set(
			memberPubkeys
				.map((pubkey) => normalizePubKey(pubkey))
				.filter((pubkey) => pubkey && pubkey !== normalizedActive)
		)
	];
}

function resolveMemberDisplayName(
	memberPubkeys: string[],
	activePubkey: string,
	profileHints?: ChatGroupProfileHints
): string | undefined {
	const otherMemberPubkeys = dedupeOtherMemberPubkeys(memberPubkeys, activePubkey);

	if (otherMemberPubkeys.length === 1) {
		return getProfileDisplayName(otherMemberPubkeys[0], profileHints);
	}

	if (otherMemberPubkeys.length > 1) {
		const visibleNames = otherMemberPubkeys
			.slice(0, 1)
			.map((pubkey) => getProfileDisplayName(pubkey, profileHints));
		const remainingCount = otherMemberPubkeys.length - visibleNames.length;
		return remainingCount > 0
			? `${visibleNames.join(', ')} +${remainingCount}`
			: visibleNames.join(', ');
	}

	return undefined;
}

export function getChatGroupDisplayTitle(input: {
	group: StoredChatGroup;
	activePubkey?: string;
	profileHints?: ChatGroupProfileHints;
	memberPubkeys?: string[];
}) {
	const explicitName = input.group.metadata?.name?.trim() ?? '';
	if (explicitName && !explicitName.startsWith(DIRECT_CHAT_NAME_PREFIX)) return explicitName;

	const memberName = resolveMemberDisplayName(
		input.memberPubkeys ?? [],
		input.activePubkey ?? '',
		input.profileHints
	);
	if (memberName) return memberName;

	const targetPubkey = getDirectChatTargetPubkey(input.group);
	if (targetPubkey) {
		return getProfileDisplayName(targetPubkey, input.profileHints);
	}

	return input.group.id || 'Unnamed chat';
}

export function resolveWelcomeDisplayName(input: {
	welcomeName: string;
	profileHints?: ChatGroupProfileHints;
	memberPubkeys?: string[];
	activePubkey?: string;
}): string {
	const targetPubkey = getDirectChatTargetPubkeyFromWelcome(input.welcomeName);
	if (targetPubkey) {
		return getProfileDisplayName(targetPubkey, input.profileHints);
	}
	if (input.welcomeName) return input.welcomeName;

	const memberName = resolveMemberDisplayName(
		input.memberPubkeys ?? [],
		input.activePubkey ?? '',
		input.profileHints
	);
	if (memberName) return memberName;

	return 'New conversation';
}

export function getDirectChatTargetPubkeyFromWelcome(welcomeName: string): string {
	if (welcomeName.startsWith(DIRECT_CHAT_NAME_PREFIX)) {
		const pubkey = welcomeName.slice(DIRECT_CHAT_NAME_PREFIX.length);
		return normalizePubKey(pubkey) ?? '';
	}
	return '';
}

const emojiIconCache = new Map<string, string>();

function emojiToNotificationIcon(emoji: string): string {
	const cached = emojiIconCache.get(emoji);
	if (cached) return cached;

	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 64;
	const ctx = canvas.getContext('2d')!;
	ctx.font = '48px serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(emoji, 32, 32);
	const dataUrl = canvas.toDataURL('image/png');
	emojiIconCache.set(emoji, dataUrl);
	return dataUrl;
}

/**
 * Returns the single member pubkey that represents a 1:1 conversation (the
 * explicit direct-chat target, or the one other member), or `undefined` for
 * group conversations. Mirrors the single-avatar selection rule used by
 * `ChatGroupAvatar.svelte`.
 */
export function getRepresentativeMemberPubkey(
	group: StoredChatGroup,
	ctx: { activePubkey?: string; memberPubkeys?: string[] } = {}
): string | undefined {
	const direct = getDirectChatTargetPubkey(group);
	if (direct) return direct;
	const others = dedupeOtherMemberPubkeys(ctx.memberPubkeys ?? [], ctx.activePubkey ?? '');
	return others.length === 1 ? others[0] : undefined;
}

export interface ChatGroupNotificationIconContext {
	activePubkey?: string;
	memberPubkeys?: string[];
	profileHints?: ChatGroupProfileHints;
}

/**
 * Resolves the image URL to display as a chat group's notification icon.
 *
 * Precedence matches `ChatGroupAvatar.svelte`: explicit group image → emoji
 * icon → (for 1:1 chats) the other member's profile picture. Returns
 * `undefined` when no suitable image is available so callers can fall back to
 * the default favicon.
 */
export function getChatGroupNotificationIcon(
	group: StoredChatGroup,
	ctx: ChatGroupNotificationIconContext = {}
): string | undefined {
	if (group.metadata?.imageUrl) return group.metadata.imageUrl;
	if (group.metadata?.icon) return emojiToNotificationIcon(group.metadata.icon);
	const representative = getRepresentativeMemberPubkey(group, ctx);
	return representative ? ctx.profileHints?.[representative]?.picture : undefined;
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('image load failed'));
		img.src = src;
	});
}

function rasterizePngBase64(img: HTMLImageElement, size: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	// Cover-fit the source into the square (Android masks largeIcon to a circle automatically).
	const sw = img.naturalWidth || size;
	const sh = img.naturalHeight || size;
	const scale = Math.max(size / sw, size / sh);
	const dw = sw * scale;
	const dh = sh * scale;
	ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
	return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
}

/**
 * Render a group's notification icon to uniform PNG bytes (base64, no `data:` prefix) for the
 * native notification `largeIcon` cache. Returns `null` when no icon source is available or the
 * render fails (e.g. a cross-origin image without CORS). All rendering happens here, in the
 * alive WebView — the key-less background worker only decodes the bytes (roadmap §4.4).
 */
export async function renderGroupNotificationIconBytes(
	group: StoredChatGroup,
	ctx: ChatGroupNotificationIconContext = {}
): Promise<string | null> {
	return renderNotificationIconFromSrc(getChatGroupNotificationIcon(group, ctx));
}

/** Rasterize a resolved icon source URL/data-URL to PNG base64 bytes. */
export async function renderNotificationIconFromSrc(
	src: string | undefined
): Promise<string | null> {
	if (!src) return null;
	try {
		return rasterizePngBase64(await loadImageEl(src), 96);
	} catch {
		return null;
	}
}
