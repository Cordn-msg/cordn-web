import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import {
	CHAT_GROUP_MUTE_ALWAYS,
	deleteChatGroupMutesForOwner,
	getChatGroupMuteCutoff,
	isChatGroupMuted,
	isMuteCutoffActive,
	loadChatGroupMutesForOwner,
	muteChatGroup,
	removeChatGroupMute,
	unmuteChatGroup
} from './chatGroupMutes.svelte';

const store = new Map<string, string>();
const localStorageStub = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key)
};
const owner = 'aa'.repeat(32);

describe('chatGroupMutes', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', localStorageStub);
		store.clear();
		loadChatGroupMutesForOwner(owner);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test('timed and always mutes persist under the active owner key', () => {
		const before = Date.now();
		const cutoff = muteChatGroup('g1', 60 * 60 * 1000);
		expect(cutoff).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
		expect(isChatGroupMuted('g1')).toBe(true);

		muteChatGroup('g2', CHAT_GROUP_MUTE_ALWAYS);
		expect(getChatGroupMuteCutoff('g2')).toBe(CHAT_GROUP_MUTE_ALWAYS);

		const stored = JSON.parse(store.get(`cordn-chat-group-mutes:${owner}`)!);
		expect(stored.g1).toBe(cutoff);
		expect(stored.g2).toBe(CHAT_GROUP_MUTE_ALWAYS);
	});

	test('mutes are scoped per owner and reload restores them', () => {
		muteChatGroup('g1', 60 * 60 * 1000);

		loadChatGroupMutesForOwner('bb'.repeat(32));
		expect(isChatGroupMuted('g1')).toBe(false);

		loadChatGroupMutesForOwner(owner);
		expect(isChatGroupMuted('g1')).toBe(true);
	});

	test('a timed mute expires; unmute keeps an immediate cutoff', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		loadChatGroupMutesForOwner(owner);

		muteChatGroup('g1', 60_000);
		expect(isChatGroupMuted('g1')).toBe(true);
		vi.advanceTimersByTime(60_001);
		expect(isChatGroupMuted('g1')).toBe(false);

		const cutoff = unmuteChatGroup('g1');
		expect(cutoff).toBeGreaterThan(0);
		expect(isChatGroupMuted('g1')).toBe(false);
		expect(getChatGroupMuteCutoff('g1')).toBe(cutoff);
	});

	test('always mutes until unmuted regardless of the clock', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		loadChatGroupMutesForOwner(owner);

		muteChatGroup('g1', CHAT_GROUP_MUTE_ALWAYS);
		vi.advanceTimersByTime(10 * 365 * 24 * 60 * 60 * 1000);
		expect(isChatGroupMuted('g1')).toBe(true);
	});

	test('cutoff boundaries', () => {
		const now = 1_000_000;
		expect(isMuteCutoffActive(-2, now)).toBe(true); // any negative is the always sentinel
		expect(isMuteCutoffActive(0, now)).toBe(false);
		expect(isMuteCutoffActive(now, now)).toBe(false);
		expect(isMuteCutoffActive(now + 1, now)).toBe(true);
		expect(isMuteCutoffActive(CHAT_GROUP_MUTE_ALWAYS, now)).toBe(true);
	});

	test('delete wipes storage and state; removeChatGroupMute drops one id', () => {
		muteChatGroup('g1', 60 * 60 * 1000);
		muteChatGroup('g2', CHAT_GROUP_MUTE_ALWAYS);

		removeChatGroupMute('g1');
		expect(getChatGroupMuteCutoff('g1')).toBe(0);
		expect(isChatGroupMuted('g2')).toBe(true);

		deleteChatGroupMutesForOwner(owner);
		expect(isChatGroupMuted('g2')).toBe(false);
		expect(store.has(`cordn-chat-group-mutes:${owner}`)).toBe(false);
	});

	test('corrupt or invalid stored payloads reset instead of throwing', () => {
		store.set(`cordn-chat-group-mutes:${owner}`, '{not json');
		loadChatGroupMutesForOwner(owner);
		expect(getChatGroupMuteCutoff('g1')).toBe(0);

		store.set(`cordn-chat-group-mutes:${owner}`, JSON.stringify({ g1: 'soon', g2: 42 }));
		loadChatGroupMutesForOwner(owner);
		expect(getChatGroupMuteCutoff('g1')).toBe(0);
		expect(getChatGroupMuteCutoff('g2')).toBe(42);
	});
});
