import { describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('$lib/services/accountManager.svelte', () => ({
	manager: { getActive: () => undefined, active: undefined }
}));
vi.mock('$lib/services/chatGroups.svelte', () => ({
	listChatGroups: () => []
}));
vi.mock('$lib/services/chatKeyPackages.svelte', () => ({
	listChatKeyPackages: () => []
}));

import { getChatCoordinator, upsertChatCoordinator } from './chatCoordinators.svelte';

describe('upsertChatCoordinator label semantics', () => {
	test('undefined label preserves a user-set label; blank label resets to the auto default', () => {
		const key = 'ab'.repeat(32);
		upsertChatCoordinator({ pubkey: key, label: 'My relay' });
		// Pubkey-only touch (profile start-chat, share-link registration) must not
		// clobber the user's label.
		upsertChatCoordinator({ pubkey: key });
		expect(getChatCoordinator(key)?.label).toBe('My relay');
		// Explicit blank (edit-form clear) falls back to the auto default so
		// getCoordinatorLabel can prefer the server-announced name again.
		upsertChatCoordinator({ pubkey: key, label: '   ' });
		expect(getChatCoordinator(key)?.label).toBe(`Coordinator ${key.slice(0, 8)}`);
	});
});
