import { contrastRatio, CONTRAST_PAIRS } from './contrast';
import type { ThemeDefinition, ThemeTokenSet } from './types';

/**
 * Random theme generation. Everything is built in HSL around a base hue with
 * recipe-driven parameters, then text colors are *solved* for a target
 * contrast (walking lightness until contrastRatio() passes), and the whole
 * result must clear every CONTRAST_PAIR at WCAG AA or the roll is retried.
 * The shared contrast checker is the quality gate, so generated themes are
 * held to the exact same bar as the hand-tuned built-ins.
 */

function hslToHex(h: number, s: number, l: number): string {
	h = ((h % 360) + 360) % 360;
	s = Math.min(Math.max(s, 0), 1);
	l = Math.min(Math.max(l, 0), 1);
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r: number, g: number, b: number;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const hex = (v: number) =>
		Math.round((v + m) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

/**
 * Find a lightness for a foreground of the given hue/sat that reaches `target`
 * contrast against `bg`, walking from `l0` toward 1 (light text) or 0 (dark).
 */
function solveFg(
	bg: string,
	h: number,
	s: number,
	l0: number,
	target: number,
	toward: number
): string {
	let best = hslToHex(h, s, l0);
	for (let l = l0; toward > 0.5 ? l <= 1 : l >= 0; l += toward > 0.5 ? 0.02 : -0.02) {
		const candidate = hslToHex(h, s, l);
		const ratio = contrastRatio(candidate, bg);
		if (ratio === null) break;
		best = candidate;
		if (ratio >= target) break;
	}
	return best;
}

type Variant = 'light' | 'dark';

function buildSet(variant: Variant, p: RecipeParams): ThemeTokenSet {
	const light = variant === 'light';
	// Surface lightness anchors for each mode.
	const bgL = light ? rand(0.93, 0.97) : rand(0.09, 0.13);
	const step = (base: number, d: number) => Math.min(Math.max(base + (light ? -d : d), 0), 1);
	const surface = (l: number) => hslToHex(p.hue, p.surfaceSat, l);

	const background = surface(bgL);
	const card = surface(step(bgL, rand(0.015, 0.03)));
	const popover = surface(step(bgL, rand(0.03, 0.05)));
	const panel = surface(step(bgL, rand(0.06, 0.1))); // secondary/accent/muted share a tint

	// Text solved against the real background for guaranteed ratios.
	const fgDir = light ? 0 : 1;
	const fgSat = Math.min(p.surfaceSat + 0.1, 0.35);
	const foreground = solveFg(
		background,
		p.hue,
		fgSat,
		light ? rand(0.3, 0.4) : rand(0.6, 0.7),
		rand(6.5, 9),
		fgDir
	);
	const muted = solveFg(
		background,
		p.hue,
		fgSat,
		light ? rand(0.45, 0.55) : rand(0.5, 0.6),
		4.6,
		fgDir
	);

	const primaryL = light ? rand(0.3, 0.42) : rand(0.58, 0.7);
	const primary = hslToHex(p.accentHue, p.accentSat, primaryL);
	const primaryFg = solveFg(primary, p.accentHue, 0.08, light ? 0.05 : 0.95, 4.6, light ? 1 : 0);

	const destructive = light
		? hslToHex(pick([0, 3, 8]), rand(0.55, 0.7), 0.42)
		: hslToHex(pick([0, 3, 8]), rand(0.5, 0.65), 0.66);

	const border = surface(step(bgL, rand(0.12, 0.2)));
	const input = surface(step(bgL, rand(0.16, 0.24)));

	return {
		background,
		foreground,
		card,
		'card-foreground': foreground,
		popover,
		'popover-foreground': foreground,
		primary,
		'primary-foreground': primaryFg,
		secondary: panel,
		'secondary-foreground': foreground,
		muted: panel,
		'muted-foreground': muted,
		accent: panel,
		'accent-foreground': foreground,
		destructive,
		border,
		input,
		ring: hslToHex(p.accentHue, Math.min(p.accentSat, 0.5), light ? 0.5 : 0.6),
		radius: p.radius
	};
}

interface RecipeParams {
	hue: number;
	surfaceSat: number;
	accentHue: number;
	accentSat: number;
	radius: string;
}

const RADII = ['0rem', '0.125rem', '0.25rem', '0.375rem', '0.5rem', '0.625rem', '0.75rem'];

/** Style recipes constrain the randomness so results read as designed. */
const RECIPES: ((hue: number) => RecipeParams)[] = [
	// Monochrome: one hue everywhere, accent is just saturation.
	(hue) => ({
		hue,
		surfaceSat: rand(0.04, 0.1),
		accentHue: hue,
		accentSat: rand(0.15, 0.3),
		radius: pick(RADII)
	}),
	// Analogous: accent sits next to the base hue.
	(hue) => ({
		hue,
		surfaceSat: rand(0.05, 0.12),
		accentHue: hue + rand(20, 50),
		accentSat: rand(0.3, 0.5),
		radius: pick(RADII)
	}),
	// Complementary: accent opposes the base hue.
	(hue) => ({
		hue,
		surfaceSat: rand(0.05, 0.12),
		accentHue: hue + 180 + rand(-25, 25),
		accentSat: rand(0.35, 0.55),
		radius: pick(RADII)
	}),
	// Terminal: near-neutral surfaces, one vivid accent.
	(hue) => ({
		hue,
		surfaceSat: rand(0.02, 0.05),
		accentHue: hue,
		accentSat: rand(0.5, 0.75),
		radius: pick(['0rem', '0.125rem', '0.25rem'])
	}),
	// Pastel: tinted surfaces, gentle accent.
	(hue) => ({
		hue,
		surfaceSat: rand(0.2, 0.32),
		accentHue: hue + rand(-25, 25),
		accentSat: rand(0.28, 0.42),
		radius: pick(RADII)
	})
];

const ADJECTIVES = [
	'Quiet',
	'Velvet',
	'Ember',
	'Misty',
	'Northern',
	'Golden',
	'Hollow',
	'Lucid',
	'Rust',
	'Mellow',
	'Pale',
	'Deep'
] as const;
const NOUNS = [
	'Meadow',
	'Harbor',
	'Circuit',
	'Dawn',
	'Canyon',
	'Lantern',
	'Fjord',
	'Orchard',
	'Signal',
	'Thicket',
	'Lagoon',
	'Meridian'
] as const;

function passesAa(theme: ThemeDefinition): boolean {
	for (const variant of [theme.light, theme.dark]) {
		for (const pair of CONTRAST_PAIRS) {
			if ((contrastRatio(variant[pair.fg], variant[pair.bg]) ?? 0) < 4.5) return false;
		}
	}
	return true;
}

/** Roll a fresh random theme (both variants, AA-gated). */
export function randomTheme(): ThemeDefinition {
	for (let attempt = 0; attempt < 40; attempt++) {
		const hue = rand(0, 360);
		const params = pick(RECIPES)(hue);
		const theme: ThemeDefinition = {
			id: crypto.randomUUID(),
			name: `${pick(ADJECTIVES)} ${pick(NOUNS)}`,
			light: buildSet('light', params),
			dark: buildSet('dark', params)
		};
		if (passesAa(theme)) return theme;
	}
	// unreachable in practice: recipes solve text for their targets up front
	throw new Error('randomTheme: could not generate an AA-passing theme');
}
