import { browser } from '$app/environment';
import { BUILTIN_THEMES, DEFAULT_THEME_ID, SOFT_THEME } from './builtin';
import type { ThemeDefinition, ThemeTokenSet } from './types';
import { THEME_TOKEN_KEYS } from './types';

/**
 * App-wide theming state + persistence.
 *
 * - Active theme id:        `cordn.theme`
 * - User-created themes:    `cordn.customThemes` (JSON array of ThemeDefinition)
 * - Compiled CSS snapshot:  `cordn.themeCss` — read by the no-flash inline
 *   script in `app.html` so the stored theme paints before hydration.
 *
 * Application mechanism: one `<style id="cordn-theme">` element with
 * `:root:root{...}` / `:root:root.dark{...}` rules. The doubled specificity
 * beats layout.css's `:root`/`.dark` defaults regardless of stylesheet order
 * (dev HMR included) while keeping dark above light inside the same tag.
 */

const THEME_KEY = 'cordn.theme';
const CUSTOM_THEMES_KEY = 'cordn.customThemes';
const THEME_CSS_KEY = 'cordn.themeCss';
const STYLE_ID = 'cordn-theme';
const CHAT_DB_NAME = 'cordn-web';

/**
 * In-progress editor session. Hoisted to module state so navigating away and
 * back keeps the draft (previews keep painting app-wide while editing).
 * `source` is the last-saved snapshot the revert buttons restore to.
 */
export interface ThemeEditorState {
	source: ThemeDefinition;
	draft: ThemeDefinition;
}

export const appearance = $state({
	activeThemeId: DEFAULT_THEME_ID,
	customThemes: [] as ThemeDefinition[],
	themeEditor: null as ThemeEditorState | null
});

let initialized = false;

export function getThemeById(id: string): ThemeDefinition | undefined {
	return [...BUILTIN_THEMES, ...appearance.customThemes].find((t) => t.id === id);
}

export function activeTheme(): ThemeDefinition {
	return getThemeById(appearance.activeThemeId) ?? SOFT_THEME;
}

export function isHexColor(value: string): boolean {
	// CSS-valid forms only: #rgb, #rgba, #rrggbb, #rrggbbaa (5/7-digit hex is
	// accepted by the old {3,8} shape but is invalid CSS and silently drops the
	// whole token — imported themes must not carry it).
	return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());
}

function isCssLength(value: string): boolean {
	return /^\d+(\.\d+)?(rem|px|em)$/.test(value.trim());
}

/** Keep only known tokens with well-formed values (missing keys absent). */
function cleanTokenSet(input: unknown): Partial<ThemeTokenSet> {
	const out: Partial<ThemeTokenSet> = {};
	if (!input || typeof input !== 'object') return out;
	for (const key of THEME_TOKEN_KEYS) {
		const value = (input as Record<string, unknown>)[key];
		if (typeof value !== 'string') continue;
		const valid = key === 'radius' ? isCssLength(value) : isHexColor(value);
		if (valid) out[key] = value.trim();
	}
	return out;
}

function sanitizeTokenSet(input: unknown, fallback: ThemeTokenSet): ThemeTokenSet {
	return { ...fallback, ...cleanTokenSet(input) };
}

/**
 * Parse a theme JSON object (the editor/export shape). Returns only the valid
 * pieces: a trimmed name and token sets containing just the well-formed keys,
 * so callers decide what to merge over (Soft defaults for imports, the current
 * draft for editor pastes). Returns null when nothing usable is present.
 */
export function parseThemeJson(
	raw: string
): { name?: string; light?: Partial<ThemeTokenSet>; dark?: Partial<ThemeTokenSet> } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const { name, light, dark } = parsed as Record<string, unknown>;
	const cleanLight = cleanTokenSet(light);
	const cleanDark = cleanTokenSet(dark);
	const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : undefined;
	if (!cleanName && !Object.keys(cleanLight).length && !Object.keys(cleanDark).length) return null;
	return { name: cleanName, light: cleanLight, dark: cleanDark };
}

function sanitizeTheme(input: unknown): ThemeDefinition | null {
	if (!input || typeof input !== 'object') return null;
	const { name, light, dark } = input as Record<string, unknown>;
	if (typeof name !== 'string' || !name.trim()) return null;
	return {
		id: '', // callers always assign a real id
		name: name.trim().slice(0, 40),
		light: sanitizeTokenSet(light, SOFT_THEME.light),
		dark: sanitizeTokenSet(dark, SOFT_THEME.dark)
	};
}

export function themeCss(theme: ThemeDefinition): string {
	const vars = (set: ThemeTokenSet) =>
		THEME_TOKEN_KEYS.map((key) => `--${key}:${set[key]};`).join('');
	return `:root:root{${vars(theme.light)}}:root:root.dark{${vars(theme.dark)}}`;
}

function applyThemeStyle(theme: ThemeDefinition, persist: boolean) {
	if (!browser) return;
	let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style = document.createElement('style');
		style.id = STYLE_ID;
		document.head.appendChild(style);
	}
	style.textContent = themeCss(theme);
	if (persist) localStorage.setItem(THEME_CSS_KEY, style.textContent);
	syncMetaColor(theme);
}

function syncMetaColor(theme: ThemeDefinition) {
	if (!browser) return;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (!meta) return;
	const dark = document.documentElement.classList.contains('dark');
	const hex = dark ? theme.dark.background : theme.light.background;
	// Meta theme-color must be opaque; drop any alpha byte.
	meta.setAttribute('content', hex.length === 9 ? hex.slice(0, 7) : hex);
}

export function setTheme(id: string) {
	const theme = getThemeById(id);
	if (!theme) return;
	appearance.activeThemeId = id;
	localStorage.setItem(THEME_KEY, id);
	applyThemeStyle(theme, true);
}

export function forkTheme(source: ThemeDefinition): ThemeDefinition {
	return {
		id: crypto.randomUUID(),
		name: `${source.name} (custom)`.slice(0, 40),
		light: { ...source.light },
		dark: { ...source.dark }
	};
}

/** Live-preview a draft without persisting anything. */
export function previewTheme(draft: ThemeDefinition) {
	applyThemeStyle(draft, false);
}

/** Open (or re-open) the editor on a theme: built-ins fork, customs copy. */
export function openThemeEditor(source: ThemeDefinition) {
	const base = BUILTIN_THEMES.some((t) => t.id === source.id) ? forkTheme(source) : source;
	appearance.themeEditor = {
		source,
		draft: { ...base, light: { ...base.light }, dark: { ...base.dark } }
	};
}

export function closeThemeEditor() {
	appearance.themeEditor = null;
}

export function saveCustomTheme(def: ThemeDefinition) {
	const existing = appearance.customThemes.findIndex((t) => t.id === def.id);
	if (existing >= 0) appearance.customThemes[existing] = def;
	else appearance.customThemes.push(def);
	localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(appearance.customThemes));
	setTheme(def.id);
}

export function deleteCustomTheme(id: string) {
	appearance.customThemes = appearance.customThemes.filter((t) => t.id !== id);
	localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(appearance.customThemes));
	if (appearance.activeThemeId === id) setTheme(DEFAULT_THEME_ID);
}

function persistCustomThemes() {
	localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(appearance.customThemes));
}

export function importTheme(raw: string): ThemeDefinition | null {
	const parsed = parseThemeJson(raw);
	if (!parsed?.name) return null;
	const theme: ThemeDefinition = {
		id: crypto.randomUUID(),
		name: parsed.name,
		light: { ...SOFT_THEME.light, ...parsed.light },
		dark: { ...SOFT_THEME.dark, ...parsed.dark }
	};
	const taken = new Set([...BUILTIN_THEMES, ...appearance.customThemes].map((t) => t.name));
	if (taken.has(theme.name)) theme.name = `${theme.name} (imported)`.slice(0, 40);
	appearance.customThemes.push(theme);
	persistCustomThemes();
	setTheme(theme.id);
	return theme;
}

export function exportTheme(theme: ThemeDefinition) {
	const payload = {
		format: 'cordn-theme',
		version: 1,
		name: theme.name,
		light: theme.light,
		dark: theme.dark
	};
	const url = URL.createObjectURL(
		new Blob([JSON.stringify(payload, null, '\t')], { type: 'application/json' })
	);
	const a = document.createElement('a');
	a.href = url;
	a.download = `cordn-theme-${theme.id}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

async function looksLikeExistingUser(): Promise<boolean> {
	if (Object.keys(localStorage).some((k) => k.startsWith('cordn.'))) return true;
	try {
		const dbs = await indexedDB.databases();
		return dbs.some((d) => d.name === CHAT_DB_NAME);
	} catch {
		return false;
	}
}

/**
 * Boot the theming system. Called once from the root layout mount; the inline
 * script in app.html has already painted the stored CSS, so this mainly
 * re-affirms state and runs the one-time default migration.
 */
export async function initAppearance() {
	if (!browser || initialized) return;
	initialized = true;

	let customs: ThemeDefinition[] = [];
	try {
		const stored = JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY) ?? '[]');
		if (Array.isArray(stored)) {
			for (const item of stored) {
				const theme = sanitizeTheme(item);
				if (theme) {
					const storedId = (item as { id?: unknown }).id;
					theme.id = typeof storedId === 'string' && storedId ? storedId : crypto.randomUUID();
					customs.push(theme);
				}
			}
		}
	} catch {
		customs = [];
	}
	appearance.customThemes = customs;

	const storedId = localStorage.getItem(THEME_KEY);
	if (storedId && getThemeById(storedId)) {
		appearance.activeThemeId = storedId;
		applyThemeStyle(activeTheme(), true);
	} else {
		// One-time migration: anyone who already used Cordn stays on Classic;
		// fresh installs start on the lower-contrast Soft default.
		setTheme((await looksLikeExistingUser()) ? 'classic' : DEFAULT_THEME_ID);
	}

	const root = document.documentElement;
	// Class flips (dark/light) re-read the active theme; previews call
	// syncMetaColor themselves with the draft being applied.
	new MutationObserver(() => syncMetaColor(activeTheme())).observe(root, {
		attributes: true,
		attributeFilter: ['class']
	});
}
