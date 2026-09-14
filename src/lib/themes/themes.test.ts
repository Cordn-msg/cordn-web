import { describe, it, expect } from 'vitest';
import { contrastRatio } from './contrast';
import { BUILTIN_THEMES } from './builtin';
import { themeCss, parseThemeJson } from './appearance.svelte';
import { THEME_TOKEN_KEYS } from './types';

describe('contrastRatio', () => {
	it('black on white is 21:1', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
	});

	it('same color is 1:1', () => {
		expect(contrastRatio('#ababab', '#ababab')).toBeCloseTo(1, 1);
	});

	it('composites foreground alpha over the background', () => {
		// A fully transparent foreground over any background is the background itself.
		expect(contrastRatio('#ffffff00', '#123456')).toBeCloseTo(1, 1);
		// Opaque white equals white at 100% alpha.
		expect(contrastRatio('#ffffffff', '#123456')).toBeCloseTo(
			contrastRatio('#ffffff', '#123456')!,
			5
		);
	});

	it('accepts 3-digit shorthand', () => {
		expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 1);
	});

	it('returns null for garbage', () => {
		expect(contrastRatio('oklch(0.5 0 0)', '#fff')).toBeNull();
		expect(contrastRatio('', '#fff')).toBeNull();
	});
});

describe('built-in themes', () => {
	it('every token key is present and hex-formatted in both variants', () => {
		for (const theme of BUILTIN_THEMES) {
			for (const variant of [theme.light, theme.dark]) {
				for (const key of THEME_TOKEN_KEYS) {
					const expected = key === 'radius' ? /^[\d.]+(rem|px|em)$/ : /^#[0-9a-f]{3,8}$/i;
					expect(variant[key], `${theme.id}.${key}`).toMatch(expected);
				}
			}
		}
	});

	it('key pairs meet WCAG AA (>= 4.5:1)', () => {
		for (const theme of BUILTIN_THEMES) {
			for (const variant of [theme.light, theme.dark]) {
				for (const [fg, bg] of [
					['foreground', 'background'],
					['muted-foreground', 'background'],
					['primary-foreground', 'primary']
				] as const) {
					expect(
						contrastRatio(variant[fg], variant[bg]),
						`${theme.id} ${fg}/${bg}`
					).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});

	it('soft body text is softer than classic (the point of the feature)', () => {
		const classic = contrastRatio('#0a0a0a', '#ffffff')!;
		const soft = contrastRatio('#41413d', '#f5f5f2')!;
		expect(soft).toBeLessThan(classic);
	});
});

describe('parseThemeJson', () => {
	it('accepts the export shape and keeps only valid tokens', () => {
		const parsed = parseThemeJson(
			JSON.stringify({
				format: 'cordn-theme',
				version: 1,
				name: 'Pasted',
				light: { background: '#123456', foreground: 'javascript:', radius: '1rem' },
				dark: {}
			})
		);
		expect(parsed?.name).toBe('Pasted');
		expect(parsed?.light?.background).toBe('#123456');
		expect(parsed?.light?.foreground).toBeUndefined(); // invalid value dropped
		expect(parsed?.light?.radius).toBe('1rem');
		expect(Object.keys(parsed?.dark ?? {})).toHaveLength(0);
	});

	it('allows name-only and set-only payloads (partial merges)', () => {
		expect(parseThemeJson('{"name": "Renamed"}')?.name).toBe('Renamed');
		expect(parseThemeJson('{"light": {"border": "#ffffff1a"}}')?.light?.border).toBe('#ffffff1a');
	});

	it('rejects garbage and empty objects', () => {
		expect(parseThemeJson('not json')).toBeNull();
		expect(parseThemeJson('[]')).toBeNull();
		expect(parseThemeJson('{}')).toBeNull();
		expect(parseThemeJson('{"light": {"bogus": "#fff"}}')).toBeNull();
	});
});

describe('themeCss', () => {
	it('emits every token for both variants with override specificity', () => {
		const css = themeCss(BUILTIN_THEMES[0]);
		expect(css).toContain(':root:root{');
		expect(css).toContain(':root:root.dark{');
		for (const key of THEME_TOKEN_KEYS) expect(css).toContain(`--${key}:`);
	});
});
