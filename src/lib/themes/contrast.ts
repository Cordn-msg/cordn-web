import type { ThemeTokenKey, ThemeTokenSet } from './types';

/**
 * WCAG 2.x relative-luminance contrast for hex colors (`#rgb`, `#rrggbb`,
 * `#rrggbbaa`). Foreground alpha is composited over the background first so
 * translucent borders/inputs ratio honestly. Returns null for unparsable values.
 */

function parseHex(hex: string): [number, number, number, number] | null {
	const m = hex.trim().match(/^#([0-9a-f]{3,8})$/i);
	if (!m) return null;
	let h = m[1];
	if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
	return [r, g, b, a];
}

function channel(v: number): number {
	const s = v / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(fgHex: string, bgHex: string): number | null {
	const fg = parseHex(fgHex);
	const bg = parseHex(bgHex);
	if (!fg || !bg) return null;
	// Composite fg over bg when fg carries alpha.
	const [fr, fgc, fb, fa] = fg;
	const [br, bgc, bb] = bg;
	const mix = (f: number, b: number) => Math.round(f * fa + b * (1 - fa));
	const l1 = luminance([mix(fr, br), mix(fgc, bgc), mix(fb, bb)]);
	const l2 = luminance([br, bgc, bb]);
	return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export interface ContrastPair {
	label: string;
	fg: ThemeTokenKey;
	bg: ThemeTokenKey;
}

/** Key foreground/background pairs worth showing ratio chips for in the editor. */
export const CONTRAST_PAIRS: ContrastPair[] = [
	{ label: 'Body text', fg: 'foreground', bg: 'background' },
	{ label: 'Muted text', fg: 'muted-foreground', bg: 'background' },
	{ label: 'On card', fg: 'card-foreground', bg: 'card' },
	{ label: 'On popover', fg: 'popover-foreground', bg: 'popover' },
	{ label: 'On primary', fg: 'primary-foreground', bg: 'primary' },
	{ label: 'Destructive', fg: 'destructive', bg: 'background' }
];

export function contrastForSet(set: ThemeTokenSet, pair: ContrastPair): number | null {
	return contrastRatio(set[pair.fg], set[pair.bg]);
}
