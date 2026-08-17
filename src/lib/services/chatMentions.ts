import { nip19 } from 'nostr-tools';
import { isGroupRef } from '@cordn/core';

import type { ChatMentionReference } from '$lib/components/chat/chat.types';
import { normalizePubKey, samePubKey } from '$lib/utils';

export interface SerializedChatMentions {
	content: string;
	tags: string[][];
}

export type ChatMentionTextPart =
	| { type: 'text'; text: string }
	| { type: 'profile'; text: string; pubkey: string }
	| { type: 'link'; text: string; href: string };

const NOSTR_PROFILE_REFERENCE_PATTERN =
	/nostr:((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+)/g;
const URL_PATTERN = /https?:\/\/[^\s<]+[^\s<.,!?;:()[\]{}"']/g;
// Bare cordn1 group reference (spec/applications/group-ref.md). Loose charset;
// isGroupRef validates the matched token before it becomes a link.
const CORDN_REF_PATTERN = /cordn1[0-9a-z]{6,}/g;
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

function appendTextWithLinks(parts: ChatMentionTextPart[], text: string) {
	// Collect link-worthy tokens: http(s) URLs and bare cordn1 group refs. A
	// cordn1 inside a URL (e.g. https://cordn.net/chat/cordn1…) is skipped by the
	// overlap guard below so the whole URL stays one link.
	const tokens: { index: number; value: string }[] = [];
	for (const match of text.matchAll(URL_PATTERN)) {
		tokens.push({ index: match.index ?? 0, value: match[0] });
	}
	for (const match of text.matchAll(CORDN_REF_PATTERN)) {
		if (isGroupRef(match[0])) {
			tokens.push({ index: match.index ?? 0, value: match[0] });
		}
	}
	tokens.sort((a, b) => a.index - b.index);

	let lastIndex = 0;
	for (const token of tokens) {
		if (token.index < lastIndex) continue; // overlap: token is inside an earlier link
		if (token.index > lastIndex) {
			parts.push({ type: 'text', text: text.slice(lastIndex, token.index) });
		}
		parts.push({ type: 'link', text: token.value, href: token.value });
		lastIndex = token.index + token.value.length;
	}

	if (lastIndex < text.length) {
		parts.push({ type: 'text', text: text.slice(lastIndex) });
	}
}

export function parseChatProfileMentions(content: string): ChatMentionTextPart[] {
	const parts: ChatMentionTextPart[] = [];
	let lastIndex = 0;

	for (const match of content.matchAll(NOSTR_PROFILE_REFERENCE_PATTERN)) {
		const text = match[0];
		const code = match[1];
		const index = match.index ?? 0;

		if (index > lastIndex) {
			appendTextWithLinks(parts, content.slice(lastIndex, index));
		}

		try {
			const decoded = nip19.decode(code);
			if (decoded.type === 'npub') {
				parts.push({ type: 'profile', text, pubkey: decoded.data });
			} else if (decoded.type === 'nprofile') {
				parts.push({ type: 'profile', text, pubkey: decoded.data.pubkey });
			} else {
				appendTextWithLinks(parts, text);
			}
		} catch {
			appendTextWithLinks(parts, text);
		}

		lastIndex = index + text.length;
	}

	if (lastIndex < content.length) {
		appendTextWithLinks(parts, content.slice(lastIndex));
	}

	return parts.length ? parts : [{ type: 'text', text: content }];
}

export function chatMessageReferencesPubkey(tags: string[][], pubkey: string): boolean {
	const normalizedPubkey = normalizePubKey(pubkey);
	if (!normalizedPubkey) return false;

	// `p` tags are peer-controlled: samePubKey (no hex-validation throw) so a
	// malformed tag can never throw inside the unread/mention scan that the
	// sidebar and attention deriveds run for every message.
	return tags.some((tag) => tag[0] === 'p' && samePubKey(tag[1] ?? '', normalizedPubkey));
}
