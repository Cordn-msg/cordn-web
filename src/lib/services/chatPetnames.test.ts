/**
 * Local petnames: per-owner localStorage, written synchronously (user data, not
 * a cache) and namespaced so two accounts on one device never share labels.
 */
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({ storage: new Map<string, string>() }));

vi.mock('$app/environment', () => ({ browser: true }));

type PetnamesModule = typeof import('./chatPetnames.svelte');
let petnames: PetnamesModule;

const OWNER = 'dd'.repeat(32);
const ALICE = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);

beforeAll(async () => {
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => harness.storage.get(key) ?? null,
		setItem: (key: string, value: string) => void harness.storage.set(key, value),
		removeItem: (key: string) => void harness.storage.delete(key)
	});
	petnames = await import('./chatPetnames.svelte');
}, 30_000);

beforeEach(() => {
	harness.storage.clear();
	petnames.loadChatPetnamesForOwner(OWNER);
});

describe('chat petnames', () => {
	test('sets, normalizes and clears a name, persisting it per owner', () => {
		petnames.setChatPetname(ALICE, '  Mom   ');
		expect(petnames.getChatPetname(ALICE)).toBe('Mom');
		// Keys are lowercase hex, so casing can never fork an entry.
		expect(petnames.getChatPetname(ALICE.toUpperCase())).toBe('Mom');
		expect(harness.storage.get(`cordn-chat-petnames:${OWNER}`)).toBe(
			JSON.stringify({ [ALICE]: 'Mom' })
		);

		petnames.setChatPetname(ALICE, '');
		expect(petnames.getChatPetname(ALICE)).toBeUndefined();
		expect(harness.storage.get(`cordn-chat-petnames:${OWNER}`)).toBe('{}');
	});

	test('keeps labels apart per account and reloads them', () => {
		petnames.loadChatPetnamesForOwner(ALICE);
		petnames.setChatPetname(BOB, 'Work — Bob');
		expect(harness.storage.get(`cordn-chat-petnames:${ALICE}`)).toContain('Work — Bob');

		petnames.loadChatPetnamesForOwner('cc'.repeat(32));
		expect(petnames.getChatPetname(BOB)).toBeUndefined();

		petnames.loadChatPetnamesForOwner(ALICE);
		expect(petnames.getChatPetname(BOB)).toBe('Work — Bob');
	});

	test('survives corrupt storage and drops non-string entries', () => {
		harness.storage.set(`cordn-chat-petnames:${ALICE}`, 'not json');
		petnames.loadChatPetnamesForOwner(ALICE);
		expect(petnames.getChatPetname(BOB)).toBeUndefined();

		harness.storage.set(
			`cordn-chat-petnames:${ALICE}`,
			JSON.stringify({ [BOB]: 42, [ALICE]: '  Alice  ' })
		);
		petnames.loadChatPetnamesForOwner(ALICE);
		expect(petnames.getChatPetname(BOB)).toBeUndefined();
		expect(petnames.getChatPetname(ALICE)).toBe('Alice');
	});

	test('removes the whole owner record on delete', () => {
		petnames.loadChatPetnamesForOwner(ALICE);
		petnames.setChatPetname(BOB, 'Bob');
		petnames.deleteChatPetnamesForOwner(ALICE);
		expect(harness.storage.has(`cordn-chat-petnames:${ALICE}`)).toBe(false);
		expect(petnames.getChatPetname(BOB)).toBeUndefined();
	});
});
