import type { ThemeDefinition } from './types';

/**
 * Built-in themes. Values are hex so the native color picker, the editor, and
 * the contrast checker share one canonical format (8-digit hex carries alpha).
 * `classic` is a lossless conversion of the original shadcn neutral palette;
 * `soft` is the lower-contrast default (body text ~9.4:1 light / ~8.2:1 dark,
 * all muted/status pairs ≥ 4.5:1 WCAG AA).
 *
 * layout.css `:root`/`.dark` mirror `soft` so the pre-JS paint matches the
 * default; any other active theme is injected at runtime with higher
 * specificity (`:root:root`) — keep these values and layout.css in sync.
 */

export const CLASSIC_THEME: ThemeDefinition = {
	id: 'classic',
	name: 'Classic',
	light: {
		background: '#ffffff',
		foreground: '#0a0a0a',
		card: '#ffffff',
		'card-foreground': '#0a0a0a',
		popover: '#ffffff',
		'popover-foreground': '#0a0a0a',
		primary: '#171717',
		'primary-foreground': '#fafafa',
		secondary: '#f5f5f5',
		'secondary-foreground': '#171717',
		muted: '#f5f5f5',
		'muted-foreground': '#737373',
		accent: '#f5f5f5',
		'accent-foreground': '#171717',
		destructive: '#e7000b',
		border: '#e5e5e5',
		input: '#e5e5e5',
		ring: '#a1a1a1',
		radius: '0.625rem'
	},
	dark: {
		background: '#0a0a0a',
		foreground: '#fafafa',
		card: '#171717',
		'card-foreground': '#fafafa',
		popover: '#171717',
		'popover-foreground': '#fafafa',
		primary: '#e5e5e5',
		'primary-foreground': '#171717',
		secondary: '#262626',
		'secondary-foreground': '#fafafa',
		muted: '#262626',
		'muted-foreground': '#a1a1a1',
		accent: '#262626',
		'accent-foreground': '#fafafa',
		destructive: '#ff6467',
		border: '#ffffff1a',
		input: '#ffffff26',
		ring: '#737373',
		radius: '0.625rem'
	}
};

export const SOFT_THEME: ThemeDefinition = {
	id: 'soft',
	name: 'Soft',
	light: {
		background: '#f5f5f2',
		foreground: '#41413d',
		card: '#fbfbf9',
		'card-foreground': '#41413d',
		popover: '#fbfbf9',
		'popover-foreground': '#41413d',
		primary: '#45443f',
		'primary-foreground': '#fafaf7',
		secondary: '#e9e9e4',
		'secondary-foreground': '#45443f',
		muted: '#e9e9e4',
		'muted-foreground': '#6f6f67',
		accent: '#e9e9e4',
		'accent-foreground': '#45443f',
		destructive: '#b0413e',
		border: '#dcdcd6',
		input: '#dcdcd6',
		ring: '#8f8f86',
		radius: '0.625rem'
	},
	dark: {
		background: '#22272b',
		foreground: '#b8c0c7',
		card: '#272d31',
		'card-foreground': '#b8c0c7',
		popover: '#2b3236',
		'popover-foreground': '#b8c0c7',
		primary: '#c3cbd2',
		'primary-foreground': '#23282c',
		secondary: '#33393e',
		'secondary-foreground': '#d6dce1',
		muted: '#33393e',
		'muted-foreground': '#8b959d',
		accent: '#33393e',
		'accent-foreground': '#d6dce1',
		destructive: '#d1787a',
		border: '#3d444a',
		input: '#434b52',
		ring: '#79848d',
		radius: '0.625rem'
	}
};

export const BUILTIN_THEMES: ThemeDefinition[] = [SOFT_THEME, CLASSIC_THEME];

export const DEFAULT_THEME_ID = SOFT_THEME.id;
