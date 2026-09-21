import { describe, expect, it } from 'vitest';
import { resolveEnterKeySends } from './chatComposerSettings.svelte';

describe('resolveEnterKeySends', () => {
	it('explicit overrides win on any device', () => {
		expect(resolveEnterKeySends('send', true)).toBe(true);
		expect(resolveEnterKeySends('send', false)).toBe(true);
		expect(resolveEnterKeySends('newline', false)).toBe(false);
		expect(resolveEnterKeySends('newline', true)).toBe(false);
	});

	it('auto sends on keyboard devices and inserts a newline on touch devices', () => {
		expect(resolveEnterKeySends('auto', false)).toBe(true);
		expect(resolveEnterKeySends('auto', true)).toBe(false);
	});
});
