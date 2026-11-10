import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key)
});

const { hasSeenIntro, markIntroSeen, hasConfirmedBackup, markBackupConfirmed } =
	await import('./onboarding.svelte');

const alice = 'aa'.repeat(32);
const bob = 'bb'.repeat(32);

describe('onboarding state', () => {
	beforeEach(() => {
		store.clear();
	});

	test('intro is seen once per browser', () => {
		markIntroSeen();
		expect(hasSeenIntro()).toBe(true);
		expect(store.get('cordn.introSeen')).toBe('1');
	});

	test('backup confirmation is per identity', () => {
		expect(hasConfirmedBackup(alice)).toBe(false);
		markBackupConfirmed(alice);
		expect(hasConfirmedBackup(alice)).toBe(true);
		expect(hasConfirmedBackup(bob)).toBe(false);
	});

	test('empty pubkeys are ignored', () => {
		markBackupConfirmed('');
		expect(hasConfirmedBackup('')).toBe(false);
		expect(store.size).toBe(0);
	});
});
