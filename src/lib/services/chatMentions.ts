import { nip19 } from 'nostr-tools';

import type { ChatMentionReference } from '$lib/components/chat/chat.types';
import { normalizePubKey } from '$lib/utils';

export interface SerializedChatMentions {
	content: string;
	tags: string[][];
}

export type ChatMentionTextPart =
	| { type: 'text'; text: string }
	| { type: 'profile'; text: string; pubkey: string };

const NOSTR_PROFILE_REFERENCE_PATTERN =
	/nostr:((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+)/g;
const TYPED_NPUB_PATTERN =
	/(?:^|\s)(?:nostr:)?((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+)/g;
const TYPED_HEX_PUBKEY_PATTERN = /(?:^|\s)([0-9a-fA-F]{64})(?=$|\s|[.,!?;:])/g;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueMentions(mentions: ChatMentionReference[]): ChatMentionReference[] {
	const byKey = new Map<string, ChatMentionReference>();
	for (const mention of mentions) {
		const pubkey = normalizePubKey(mention.pubkey);
		const label = mention.label.trim();
		if (!pubkey || !label || byKey.has(pubkey)) continue;
		byKey.set(pubkey, { pubkey, label });
	}
	return Array.from(byKey.values()).sort((a, b) => b.label.length - a.label.length);
}

export function serializeChatProfileMentions(
	content: string,
	mentions: ChatMentionReference[]
): SerializedChatMentions {
	let serializedContent = content;
	const usedPubkeys = new Set<string>();

	for (const mention of uniqueMentions(mentions)) {
		const pattern = new RegExp(`(^|\\s)@${escapeRegExp(mention.label)}(?=$|\\s|[.,!?;:])`, 'g');
		const replacement = `nostr:${nip19.npubEncode(mention.pubkey)}`;
		serializedContent = serializedContent.replace(pattern, (_match, prefix: string) => {
			usedPubkeys.add(mention.pubkey);
			return `${prefix}${replacement}`;
		});
	}

	for (const match of serializedContent.matchAll(TYPED_NPUB_PATTERN)) {
		try {
			const decoded = nip19.decode(match[1]);
			if (decoded.type === 'npub') {
				usedPubkeys.add(normalizePubKey(decoded.data));
			} else if (decoded.type === 'nprofile') {
				usedPubkeys.add(normalizePubKey(decoded.data.pubkey));
			}
		} catch {
			// Ignore invalid bech32-looking values.
		}
	}

	for (const match of serializedContent.matchAll(TYPED_HEX_PUBKEY_PATTERN)) {
		usedPubkeys.add(normalizePubKey(match[1]));
	}

	return {
		content: serializedContent,
		tags: Array.from(usedPubkeys).map((pubkey) => ['p', pubkey])
	};
}

export function parseChatProfileMentions(content: string): ChatMentionTextPart[] {
	const parts: ChatMentionTextPart[] = [];
	let lastIndex = 0;

	for (const match of content.matchAll(NOSTR_PROFILE_REFERENCE_PATTERN)) {
		const text = match[0];
		const code = match[1];
		const index = match.index ?? 0;

		if (index > lastIndex) {
			parts.push({ type: 'text', text: content.slice(lastIndex, index) });
		}

		try {
			const decoded = nip19.decode(code);
			if (decoded.type === 'npub') {
				parts.push({ type: 'profile', text, pubkey: decoded.data });
			} else if (decoded.type === 'nprofile') {
				parts.push({ type: 'profile', text, pubkey: decoded.data.pubkey });
			} else {
				parts.push({ type: 'text', text });
			}
		} catch {
			parts.push({ type: 'text', text });
		}

		lastIndex = index + text.length;
	}

	if (lastIndex < content.length) {
		parts.push({ type: 'text', text: content.slice(lastIndex) });
	}

	return parts.length ? parts : [{ type: 'text', text: content }];
}

export function chatMessageReferencesPubkey(tags: string[][], pubkey: string): boolean {
	const normalizedPubkey = normalizePubKey(pubkey);
	if (!normalizedPubkey) return false;

	return tags.some((tag) => tag[0] === 'p' && normalizePubKey(tag[1] ?? '') === normalizedPubkey);
}
