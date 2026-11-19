import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools/pure';
import { ChatKinds } from '$lib/chat/kinds';
import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';
import {
	buildCallProjection,
	createCallAnnouncementTags,
	createCallTokenRequest,
	deriveCallEphemeralKey,
	deriveCallFrameKey,
	deriveCallJoinMaterial,
	deriveCallPseudonym,
	normalizeCallService,
	parseCallAnnouncement,
	parseCallTokenGrant,
	type CallAnnouncement
} from './calls';

const exporter = Uint8Array.from({ length: 32 }, (_, index) => index);
const callId = '11'.repeat(32);
const identitySecret = '11'.repeat(32);
const alice = 'aa'.repeat(32);

const live: CallAnnouncement = {
	callId,
	service: 'https://hushwire.exe.xyz',
	status: 'open',
	startsAt: 1_762_000_000,
	identitySecret
};

function message(id: string, createdAt: number, announcement = live): StoredChatMessage {
	return {
		cursor: 1,
		createdAt,
		eventCreatedAt: createdAt,
		direction: 'inbound',
		sender: alice,
		id,
		kind: ChatKinds.Call,
		tags: createCallAnnouncementTags(announcement),
		content: ''
	};
}

describe('call announcements', () => {
	it('round-trips open and closed announcements and tolerates unknown tags', () => {
		const tags = [...createCallAnnouncementTags(live), ['future', 'ignored']];
		expect(parseCallAnnouncement(ChatKinds.Call, tags)).toEqual(live);
		const closed = {
			...live,
			status: 'closed' as const,
			identitySecret: null,
			endsAt: 1_762_000_100
		};
		expect(parseCallAnnouncement(ChatKinds.Call, createCallAnnouncementTags(closed))).toEqual(
			closed
		);
		expect(
			parseCallAnnouncement(
				ChatKinds.Call,
				createCallAnnouncementTags(live).map((tag) =>
					tag[0] === 'status' ? ['status', 'private'] : tag
				)
			)?.status
		).toBe('closed');
	});

	it('rejects malformed required fields', () => {
		const tags = createCallAnnouncementTags(live);
		for (const required of ['d', 'service', 'status', 'starts']) {
			expect(
				parseCallAnnouncement(
					ChatKinds.Call,
					tags.filter((tag) => tag[0] !== required)
				)
			).toBeNull();
		}
		expect(
			parseCallAnnouncement(
				ChatKinds.Call,
				tags.filter((tag) => tag[0] !== 'identity-secret')
			)
		).toBeNull();
		expect(parseCallAnnouncement(ChatKinds.Text, tags)).toBeNull();
	});

	it('uses greatest created_at and then greatest id across authors', () => {
		const older = message('b'.repeat(64), 100);
		const newer = message('a'.repeat(64), 200, { ...live, status: 'closed', identitySecret: null });
		const cards = buildCallProjection([older, newer]);
		expect(cards).toHaveLength(1);
		expect(cards[0].announcement.status).toBe('closed');
		expect(cards[0].revisionIds).toEqual([older.id, newer.id]);
		const tied = message('f'.repeat(64), 200, live);
		expect(buildCallProjection([newer, tied])[0].message.id).toBe(tied.id);
	});
});

describe('call key derivations', () => {
	it('matches the committed Staircase interoperability vectors', () => {
		expect(deriveCallFrameKey(exporter, callId)).toBe(
			'b7f03da0468c3cf011fb964fe8192dd01a3db4cc60b2d3ae4a14ad06c90cef54'
		);
		expect(deriveCallPseudonym(identitySecret, alice)).toBe(
			'e5e4298b637a3ce1875bdbd27e72b64d884c2fb35fcf8a03a37c15a9a5439272'
		);
		expect(bytesToHex(deriveCallEphemeralKey(exporter, callId, alice))).toBe(
			'4cd2301782cca722ff96bba79e1e9955961350f98ec1ee7c7930123ee22ef7b4'
		);
	});

	it('refuses material for an account the member list does not contain', () => {
		expect(() =>
			deriveCallJoinMaterial({
				exporter,
				callId,
				identitySecret,
				memberPubkey: alice,
				memberPubkeys: ['bb'.repeat(32)],
				deviceTag: 'Abcd1234',
				epoch: 0n
			})
		).toThrow();
	});

	it('derives the expected identity, slot and member map', () => {
		const material = deriveCallJoinMaterial({
			exporter,
			callId,
			identitySecret,
			memberPubkey: alice.toUpperCase(),
			memberPubkeys: [alice, 'bb'.repeat(32)],
			deviceTag: 'Abcd1234',
			epoch: 17n
		});
		expect(material.identity).toBe(`${material.pseudonym}:Abcd1234`);
		expect(material.keyIndex).toBe(1);
		expect(material.pseudonyms.get(material.pseudonym)).toBe(alice);
	});
});

describe('call token request', () => {
	it('signs with the throwaway key and the exact endpoint', () => {
		const material = deriveCallJoinMaterial({
			exporter,
			callId,
			identitySecret,
			memberPubkey: alice,
			memberPubkeys: [alice],
			deviceTag: 'Abcd1234',
			epoch: 0n
		});
		const request = createCallTokenRequest({
			...material,
			callId,
			service: live.service,
			nowSeconds: 100
		});
		const body = JSON.parse(request.body);
		const signedEvent = JSON.parse(body.attributes.signed_event);
		expect(request.url).toBe('https://hushwire.exe.xyz/api/get-token');
		expect(body.roomName).toBe(callId);
		expect(body.participantName).toBe(material.identity);
		expect(signedEvent.pubkey).toBe(material.publicKey);
		expect(signedEvent.pubkey).not.toBe(alice);
		expect(verifyEvent(signedEvent)).toBe(true);
	});

	it('normalizes a configured service and refuses what cannot be asked', () => {
		expect(normalizeCallService(' https://calls.example/ ')).toBe('https://calls.example');
		expect(normalizeCallService('http://localhost:8080')).toBe('http://localhost:8080');
		expect(() => normalizeCallService('http://calls.example')).toThrow(/HTTPS/);
		expect(() => normalizeCallService('calls.example')).toThrow(/full URL/);
		expect(() => normalizeCallService('https://user:pass@calls.example')).toThrow(/login/);
		expect(() => normalizeCallService('https://calls.example?x=1')).toThrow(/invalid/);
	});

	it('validates response URLs', () => {
		expect(parseCallTokenGrant({ token: 'token', url: 'wss://media.example' })).toEqual({
			token: 'token',
			url: 'wss://media.example'
		});
		expect(() => parseCallTokenGrant({ token: 'token', url: 'https://media.example' })).toThrow();
	});
});
