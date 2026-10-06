import { decodeGroupRef, isGroupRef } from '@cordn/core';
import { nip19 } from 'nostr-tools';
import type { ChatMentionTextPart } from '$lib/services/chatMentions';
import { decodeGroupMetadataQueryParam } from '$lib/utils/groupShareLink';

/**
 * Cordn invite links inside a chat message — the Staircase pattern: an invite
 * (a group, coordinator, or profile link) gets a card under the text instead of
 * a raw 90-character URL button, and the link text leaves the body the card
 * stands in for. Pure functions over the mention/link parts the message
 * pipeline already produced; no extra tokenization of the raw text.
 *
 * Deliberately NOT invites: device connection strings (a one-tap path to the
 * multi-device write key must not sit in a bubble), app pages without a payload
 * (/chat/news, /chat/config/…), and anything on a host that does not serve
 * cordn-web.
 */

export type ChatInviteTarget =
	| { type: 'chat' }
	| { type: 'info' }
	| { type: 'message'; eventId: string };

export type ChatInvite =
	| {
			kind: 'group';
			href: string;
			gid: string;
			coordinatorPubkey?: string;
			relays?: string[];
			name?: string;
			icon?: string;
			target: ChatInviteTarget;
	  }
	| { kind: 'coordinator'; href: string; pubkey: string; label?: string }
	| { kind: 'profile'; href: string; pubkey: string };

export const MAX_CHAT_INVITES_PER_MESSAGE = 3;

/** Hosts that serve cordn-web (Staircase's KNOWN_HOSTS) plus our own origin,
 * so self-hosted deployments card their own links. Unchecksummed forms (bare
 * gid paths) are only accepted from these. */
const KNOWN_CHAT_HOSTS = new Set(['cordn.net', 'www.cordn.net', 'cordn.relay.tools']);

/** /chat/ segments that are app pages, never a group id. */
const RESERVED_CHAT_SEGMENTS = new Set(['coordinators', 'create-group', 'news', 'share', 'config']);

function isKnownChatHost(hostname: string): boolean {
	if (KNOWN_CHAT_HOSTS.has(hostname)) return true;
	return typeof window !== 'undefined' && hostname === window.location.hostname;
}

function decodePubkeyParam(value: string): string | undefined {
	try {
		const decoded = nip19.decode(value);
		if (decoded.type === 'npub') return decoded.data;
		if (decoded.type === 'nprofile') return decoded.data.pubkey;
	} catch {
		// Not a bech32 pubkey — not a card.
	}
	return undefined;
}

/** Group from a bare `cordn1…` code (checksummed by isGroupRef upstream). */
function groupFromRef(code: string, href: string, target: ChatInviteTarget): ChatInvite | null {
	try {
		const ref = decodeGroupRef(code);
		return {
			kind: 'group',
			href,
			gid: ref.gid,
			coordinatorPubkey: ref.coordinatorPubkey,
			relays: ref.relays,
			target
		};
	} catch {
		return null;
	}
}

/** Classify one link href as an invite (or null). Exported for tests. */
export function classifyChatInviteHref(href: string): ChatInvite | null {
	// Bare cordn1 code (the message tokenizer already validated the checksum).
	const refPart = href.split(/[?#]/, 1)[0];
	if (isGroupRef(refPart)) return groupFromRef(refPart, href, { type: 'chat' });

	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !isKnownChatHost(url.hostname)) {
		return null;
	}

	const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const meta = (() => {
		const m = url.searchParams.get('m');
		if (!m) return null;
		const decoded = decodeGroupMetadataQueryParam(m);
		return decoded ? { name: decoded.name, icon: decoded.icon } : null;
	})();
	const withMeta = (invite: ChatInvite): ChatInvite =>
		invite.kind === 'group' && meta ? { ...invite, name: meta.name, icon: meta.icon } : invite;

	// /chat/coordinators?c=<nprofile> — the coordinator share form.
	if (segments[0] === 'chat' && segments[1] === 'coordinators' && segments.length === 2) {
		const c = url.searchParams.get('c');
		if (!c) return null;
		const pubkey = decodePubkeyParam(c);
		if (!pubkey) return null;
		return {
			kind: 'coordinator',
			href,
			pubkey,
			label: url.searchParams.get('label')?.trim() || undefined
		};
	}

	// /p/<npub|nprofile>
	if (segments[0] === 'p' && segments.length === 2) {
		const pubkey = decodePubkeyParam(segments[1]);
		return pubkey ? { kind: 'profile', href, pubkey } : null;
	}

	// /chat/<cordn1|gid>[/info|/e/<eventId>]
	if (segments[0] === 'chat' && segments.length >= 2 && !RESERVED_CHAT_SEGMENTS.has(segments[1])) {
		const target: ChatInviteTarget | null =
			segments.length === 2
				? { type: 'chat' }
				: segments.length === 3 && segments[2] === 'info'
					? { type: 'info' }
					: segments.length === 4 && segments[2] === 'e' && segments[3]
						? { type: 'message', eventId: segments[3] }
						: null;
		if (!target) return null;
		const id = segments[1];
		if (isGroupRef(id)) {
			const invite = groupFromRef(id, href, target);
			return invite ? withMeta(invite) : null;
		}
		// Legacy bare-gid form: unchecksummed, so known hosts only (already
		// guaranteed above) and a plausible id.
		if (!id || new TextEncoder().encode(id).length > 255) return null;
		const c = url.searchParams.get('c');
		const coordinatorPubkey = c ? decodePubkeyParam(c) : undefined;
		return withMeta({
			kind: 'group',
			href,
			gid: id,
			coordinatorPubkey,
			target
		});
	}

	return null;
}

export interface ExtractedChatInvites {
	/** Cards to render under the body, in message order, deduped, capped. */
	invites: ChatInvite[];
	/** The exact link texts removed from the body (one per invite). */
	linkTexts: string[];
}

/** Invites from a message's parsed parts, in order, once each, at most
 * MAX_CHAT_INVITES_PER_MESSAGE. */
export function extractChatInvites(parts: ChatMentionTextPart[]): ExtractedChatInvites {
	const seen = new Set<string>();
	const invites: ChatInvite[] = [];
	const linkTexts: string[] = [];
	for (const part of parts) {
		if (part.type !== 'link' || seen.has(part.href)) continue;
		const invite = classifyChatInviteHref(part.href);
		if (!invite) continue;
		seen.add(part.href);
		invites.push(invite);
		linkTexts.push(part.text);
		if (invites.length >= MAX_CHAT_INVITES_PER_MESSAGE) break;
	}
	return { invites, linkTexts };
}

/** The body text with invite links taken out (a card stands in for each): every
 * occurrence removed, then each line's runs of spaces collapsed and trailing
 * spaces trimmed — "join  <link>  us" reads "join us". Blank result means the
 * message was only links. */
export function tidyChatBodyText(content: string, linkTexts: string[]): string {
	let out = content;
	for (const text of linkTexts) {
		out = out.split(text).join('');
	}
	return out
		.split('\n')
		.map((line) => line.replace(/ {2,}/g, ' ').trimEnd())
		.join('\n')
		.trim();
}
