import { describe, expect, it } from 'vitest';
import { normalizePubKey, safeNormalizePubKey, samePubKey } from './utils';

describe('pubkey normalization', () => {
	it('normalizePubKey lowercases valid hex and throws on invalid input', () => {
		expect(normalizePubKey('AA'.repeat(32))).toBe('aa'.repeat(32));
		expect(() => normalizePubKey('not-hex')).toThrow();
	});

	it('safeNormalizePubKey returns empty string instead of throwing', () => {
		expect(safeNormalizePubKey('AA'.repeat(32))).toBe('aa'.repeat(32));
		expect(safeNormalizePubKey('not-hex')).toBe('');
		expect(safeNormalizePubKey('')).toBe('');
	});

	it('samePubKey compares case-insensitively without validating', () => {
		expect(samePubKey('AA'.repeat(32), 'aa'.repeat(32))).toBe(true);
		expect(samePubKey('zz', 'zz')).toBe(true);
		expect(samePubKey('aa'.repeat(32), 'bb'.repeat(32))).toBe(false);
	});
});
