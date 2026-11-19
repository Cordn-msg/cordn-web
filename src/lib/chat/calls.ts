import { expand, hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { ChatKinds } from '$lib/chat/kinds';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

export const CALL_KEY_RING_SLOTS = 16;
export const DEFAULT_CALL_SERVICE = 'https://hushwire.exe.xyz';
export const CALL_EXPORTER_LABEL = 'cordn';
export const CALL_EXPORTER_CONTEXT = 'e2ee-call';

export interface CallAnnouncement {
	callId: string;
	service: string;
	status: 'open' | 'closed';
	startsAt: number;
	identitySecret: string | null;
	endsAt?: number;
	title?: string;
}

export interface CallCard {
	announcement: CallAnnouncement;
	message: StoredChatMessage;
	revisionIds: string[];
}

export interface CallJoinMaterial {
	frameKey: string;
	keyIndex: number;
	pseudonym: string;
	identity: string;
	privateKey: Uint8Array;
	publicKey: string;
	pseudonyms: Map<string, string>;
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const DEVICE_TAG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function firstTag(tags: string[][], name: string): string | undefined {
	return tags.find((tag) => tag.length >= 2 && tag[0] === name)?.[1];
}

function unixSeconds(value: string | undefined): number | undefined {
	if (!value || !/^-?\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseCallAnnouncement(kind: number, tags: string[][]): CallAnnouncement | null {
	if (kind !== ChatKinds.Call || tags.length > 32) return null;
	const callId = firstTag(tags, 'd');
	const service = firstTag(tags, 'service')?.trim();
	const statusValue = firstTag(tags, 'status');
	const startsAt = unixSeconds(firstTag(tags, 'starts'));
	if (!callId || !HEX_32_BYTES.test(callId) || !service || !statusValue || startsAt === undefined) {
		return null;
	}
	const status = statusValue === 'open' ? 'open' : 'closed';
	const secret = firstTag(tags, 'identity-secret');
	const identitySecret = secret && HEX_32_BYTES.test(secret) ? secret : null;
	if (status === 'open' && !identitySecret) return null;
	const titleValue = firstTag(tags, 'room')?.trim();
	const title =
		titleValue && new TextEncoder().encode(titleValue).length <= 256 ? titleValue : undefined;
	const endsAt = unixSeconds(firstTag(tags, 'ends'));
	return {
		callId,
		service,
		status,
		startsAt,
		identitySecret,
		...(endsAt === undefined ? {} : { endsAt }),
		...(title ? { title } : {})
	};
}

export function createCallAnnouncementTags(announcement: CallAnnouncement): string[][] {
	const tags = [
		['d', announcement.callId],
		['service', announcement.service],
		['status', announcement.status]
	];
	if (announcement.status === 'open' && announcement.identitySecret) {
		tags.push(['identity-secret', announcement.identitySecret]);
	}
	tags.push(['starts', String(announcement.startsAt)]);
	if (announcement.endsAt !== undefined) tags.push(['ends', String(announcement.endsAt)]);
	if (announcement.title) tags.push(['room', announcement.title]);
	tags.push(['alt', announcement.status === 'closed' ? 'Call ended' : 'Call started']);
	return tags;
}

function announcementCreatedAt(message: StoredChatMessage): number {
	return message.eventCreatedAt ?? message.createdAt;
}

/** Addressable by d alone: unlike a calendar event, another member may close a call. */
export function buildCallProjection(messages: StoredChatMessage[]): CallCard[] {
	const byCall = new Map<string, CallCard>();
	for (const message of messages) {
		const announcement = parseCallAnnouncement(message.kind, message.tags);
		if (!announcement) continue;
		const current = byCall.get(announcement.callId);
		if (!current) {
			byCall.set(announcement.callId, { announcement, message, revisionIds: [message.id] });
			continue;
		}
		current.revisionIds.push(message.id);
		const createdDelta = announcementCreatedAt(message) - announcementCreatedAt(current.message);
		if (createdDelta > 0 || (createdDelta === 0 && message.id > current.message.id)) {
			current.announcement = announcement;
			current.message = message;
		}
	}
	return [...byCall.values()].sort((a, b) => a.message.cursor - b.message.cursor);
}

export function findCallCard(cards: CallCard[], eventId: string): CallCard | null {
	return cards.find((card) => card.revisionIds.includes(eventId)) ?? null;
}

export function liveCallCard(cards: CallCard[]): CallCard | null {
	return cards.findLast((card) => card.announcement.status === 'open') ?? null;
}

export function newCallId(): string {
	return bytesToHex(randomBytes(32));
}

export function newCallIdentitySecret(): string {
	return bytesToHex(randomBytes(32));
}

export function newCallDeviceTag(): string {
	return [...randomBytes(8)].map((byte) => DEVICE_TAG_ALPHABET[byte % 62]).join('');
}

export function callPseudonymOf(identity: string): string {
	return identity.split(':', 1)[0];
}

export function callKeyIndex(epoch: bigint): number {
	return Number(epoch % BigInt(CALL_KEY_RING_SLOTS));
}

export function deriveCallFrameKey(exporter: Uint8Array, callId: string): string {
	return bytesToHex(hkdf(sha256, exporter, hexToBytes(callId), utf8ToBytes('cordn-e2ee-call'), 32));
}

export function deriveCallPseudonym(identitySecret: string, memberPubkey: string): string {
	return bytesToHex(
		hmac(sha256, hexToBytes(identitySecret), utf8ToBytes(memberPubkey.toLowerCase()))
	);
}

export function deriveCallEphemeralKey(
	exporter: Uint8Array,
	callId: string,
	memberPubkey: string
): Uint8Array {
	const seed = expand(
		sha256,
		exporter,
		utf8ToBytes(`staircase-call-auth${callId}${memberPubkey.toLowerCase()}`),
		32
	);
	let scalar = BigInt(`0x${bytesToHex(seed)}`);
	const order = secp256k1.Point.CURVE().n;
	if (scalar >= order) scalar -= order;
	if (scalar === 0n) scalar = 1n;
	return hexToBytes(scalar.toString(16).padStart(64, '0'));
}

export function deriveCallJoinMaterial(input: {
	exporter: Uint8Array;
	callId: string;
	identitySecret: string;
	memberPubkey: string;
	memberPubkeys: string[];
	deviceTag: string;
	epoch: bigint;
}): CallJoinMaterial {
	const memberPubkey = input.memberPubkey.toLowerCase();
	// A device whose own state is off the group's line would derive names and a key
	// nobody else has: the member list is the only thing that can say it is still in.
	if (!input.memberPubkeys.some((pubkey) => pubkey.toLowerCase() === memberPubkey)) {
		throw new Error('This account is no longer a member of the group');
	}
	const pseudonym = deriveCallPseudonym(input.identitySecret, memberPubkey);
	const privateKey = deriveCallEphemeralKey(input.exporter, input.callId, memberPubkey);
	return {
		frameKey: deriveCallFrameKey(input.exporter, input.callId),
		keyIndex: callKeyIndex(input.epoch),
		pseudonym,
		identity: `${pseudonym}:${input.deviceTag}`,
		privateKey,
		publicKey: getPublicKey(privateKey),
		pseudonyms: new Map(
			input.memberPubkeys.map((pubkey) => [
				deriveCallPseudonym(input.identitySecret, pubkey),
				pubkey.toLowerCase()
			])
		)
	};
}

function checkedService(service: string): string {
	const normalized = service.trim().replace(/\/+$/, '');
	const url = new URL(normalized);
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username) {
		throw new Error('The call service must use HTTPS');
	}
	if (url.search || url.hash) throw new Error('The call service URL is invalid');
	return normalized;
}

export function createCallTokenRequest(input: {
	service: string;
	callId: string;
	identity: string;
	privateKey: Uint8Array;
	publicKey: string;
	nowSeconds?: number;
}): { url: string; body: string } {
	const url = `${checkedService(input.service)}/api/get-token`;
	const signedEvent = finalizeEvent(
		{
			kind: 27235,
			created_at: input.nowSeconds ?? Math.floor(Date.now() / 1000),
			tags: [
				['u', url],
				['method', 'POST']
			],
			content: ''
		},
		input.privateKey
	);
	return {
		url,
		body: JSON.stringify({
			roomName: input.callId,
			participantName: input.identity,
			pubkey: input.publicKey,
			attributes: { signed_event: JSON.stringify(signedEvent) }
		})
	};
}

export function parseCallTokenGrant(value: unknown): { token: string; url: string } {
	if (!value || typeof value !== 'object') throw new Error('The call service returned no token');
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.token !== 'string' || !candidate.token || candidate.token.length > 16_384) {
		throw new Error('The call service returned an invalid token');
	}
	if (typeof candidate.url !== 'string') throw new Error('The call service returned no media URL');
	const url = new URL(candidate.url);
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) || url.username) {
		throw new Error('The call service returned an insecure media URL');
	}
	return { token: candidate.token, url: candidate.url };
}
