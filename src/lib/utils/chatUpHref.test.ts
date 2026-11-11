import { expect, test } from 'vitest';
import { chatUpHref } from './chatUpHref';

test('the chat home has no parent — Back leaves the app there', () => {
	expect(chatUpHref('/chat')).toBeNull();
	expect(chatUpHref('/chat/')).toBeNull();
});

test('conversation children go up to their conversation, conversations to the chat list', () => {
	expect(chatUpHref('/chat/cordn1abc')).toBe('/chat');
	expect(chatUpHref('/chat/cordn1abc/info')).toBe('/chat/cordn1abc');
	expect(chatUpHref('/chat/cordn1abc/e/evt1')).toBe('/chat/cordn1abc');
});

test('settings subsections go up one level, the settings root goes to the chat list', () => {
	expect(chatUpHref('/chat/config/notifications')).toBe('/chat/config');
	expect(chatUpHref('/chat/config')).toBe('/chat');
	expect(chatUpHref('/chat/coordinators')).toBe('/chat/config');
	expect(chatUpHref('/chat/coordinators/abc')).toBe('/chat/coordinators');
});

test('chat siblings and profile pages go to the chat list', () => {
	for (const path of ['/chat/news', '/chat/create-group', '/chat/share', '/p/npub1abc', '/']) {
		expect(chatUpHref(path)).toBe('/chat');
	}
});
