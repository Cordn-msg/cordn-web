import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import {
	deleteChatGroupPinsForOwner,
	isChatGroupPinned,
	loadChatGroupPinsForOwner,
	removeChatGroupPin,
	toggleChatGroupPin
} from './chatGroupPins.svelte';

const store = new Map<string, string>();
const localStorageStub = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key)
};

describe('chatGroupPins', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', localStorageStub);
		store.clear();
		loadChatGroupPinsForOwner(undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('toggle persists under the active owner key', () => {
		loadChatGroupPinsForOwner('aa'.repeat(32));

		expect(isChatGroupPinned('g1')).toBe(false);
		toggleChatGroupPin('g1');
		expect(isChatGroupPinned('g1')).toBe(true);
		toggleChatGroupPin('g1');
		expect(isChatGroupPinned('g1')).toBe(false);

		toggleChatGroupPin('g1');
		toggleChatGroupPin('g2');
		expect(JSON.parse(store.get(`cordn-chat-group-pins:${'aa'.repeat(32)}`)!)?.sort()).toEqual([
			'g1',
			'g2'
		]);
	});

	test('pins are scoped per owner and reload restores them', () => {
		loadChatGroupPinsForOwner('aa'.repeat(32));
		toggleChatGroupPin('g1');

		loadChatGroupPinsForOwner('bb'.repeat(32));
		expect(isChatGroupPinned('g1')).toBe(false);

		loadChatGroupPinsForOwner('aa'.repeat(32));
		expect(isChatGroupPinned('g1')).toBe(true);
	});

	test('delete wipes storage and state; removeChatGroupPin drops one id', () => {
		const owner = 'aa'.repeat(32);
		loadChatGroupPinsForOwner(owner);
		toggleChatGroupPin('g1');
		toggleChatGroupPin('g2');
		removeChatGroupPin('g1');
		expect(isChatGroupPinned('g1')).toBe(false);
		expect(isChatGroupPinned('g2')).toBe(true);

		deleteChatGroupPinsForOwner(owner);
		expect(isChatGroupPinned('g2')).toBe(false);
		expect(store.has(`cordn-chat-group-pins:${owner}`)).toBe(false);
	});

	test('corrupt stored payload resets to empty instead of throwing', () => {
		store.set('cordn-chat-group-pins', '{not json');
		loadChatGroupPinsForOwner(undefined);
		expect(isChatGroupPinned('g1')).toBe(false);
	});
});
