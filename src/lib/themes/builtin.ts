import type { ThemeDefinition } from './types';

/**
 * Built-in themes. Values are hex so the native color picker, the editor, and
 * the contrast checker share one canonical format (8-digit hex carries alpha).
 * `classic` is a lossless conversion of the original shadcn neutral palette;
 * `soft` is the lower-contrast default (body text ~9.4:1 light / ~8.2:1 dark,
 * all muted/status pairs ≥ 4.5:1 WCAG AA). The rest of the lineup keeps the
 * same AA bar — the invariants test enforces it for every built-in pair.
 * Catppuccin ports the official Latte/Mocha palette (MIT); Dracula's light
 * variant is our own "Dracula Daylight" (no official light palette exists).
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

export const MATRIX_THEME: ThemeDefinition = {
	id: 'matrix',
	name: 'Matrix',
	light: {
		background: '#f2f7f0',
		foreground: '#26332a',
		card: '#f8fbf7',
		'card-foreground': '#26332a',
		popover: '#fbfdfa',
		'popover-foreground': '#26332a',
		primary: '#1f7a45',
		'primary-foreground': '#f0fbf3',
		secondary: '#e3ede2',
		'secondary-foreground': '#2b3b30',
		muted: '#e6efe5',
		'muted-foreground': '#5c7261',
		accent: '#dfeadd',
		'accent-foreground': '#26332a',
		destructive: '#b3362f',
		border: '#d3e0d3',
		input: '#c6d6c6',
		ring: '#4f9e6b',
		radius: '0.125rem'
	},
	dark: {
		background: '#0b0f0c',
		foreground: '#b8e6c1',
		card: '#101511',
		'card-foreground': '#b8e6c1',
		popover: '#131a14',
		'popover-foreground': '#b8e6c1',
		primary: '#57c47a',
		'primary-foreground': '#08120b',
		secondary: '#16211a',
		'secondary-foreground': '#a3d8ad',
		muted: '#131b15',
		'muted-foreground': '#7fa88a',
		accent: '#1a2b1f',
		'accent-foreground': '#b8e6c1',
		destructive: '#e06c75',
		border: '#1f2d24',
		input: '#24352a',
		ring: '#57c47a',
		radius: '0.125rem'
	}
};
export const CYPHERPUNK_THEME: ThemeDefinition = {
	id: 'cypherpunk',
	name: 'Cypherpunk',
	light: {
		background: '#faf7ec',
		foreground: '#1c1b16',
		card: '#fffdf3',
		'card-foreground': '#1c1b16',
		popover: '#fffef8',
		'popover-foreground': '#1c1b16',
		primary: '#f2d024',
		'primary-foreground': '#141405',
		secondary: '#efe9d3',
		'secondary-foreground': '#3a382c',
		muted: '#f0ecda',
		'muted-foreground': '#6b6858',
		accent: '#1c1b16',
		'accent-foreground': '#f2d024',
		destructive: '#b3261e',
		border: '#e2dbbf',
		input: '#d8d0b0',
		ring: '#141410',
		radius: '0rem'
	},
	dark: {
		background: '#0d0d0b',
		foreground: '#e8e6df',
		card: '#141412',
		'card-foreground': '#e8e6df',
		popover: '#181816',
		'popover-foreground': '#e8e6df',
		primary: '#f2d024',
		'primary-foreground': '#141405',
		secondary: '#1f1f1c',
		'secondary-foreground': '#d8d5cb',
		muted: '#1a1a18',
		'muted-foreground': '#9a978c',
		accent: '#2b2b1e',
		'accent-foreground': '#e3dfb8',
		destructive: '#e05b5b',
		border: '#26261f',
		input: '#2c2c24',
		ring: '#f2d024',
		radius: '0rem'
	}
};
export const NAVY_THEME: ThemeDefinition = {
	id: 'navy',
	name: 'Navy',
	light: {
		background: '#eef2f9',
		foreground: '#24304a',
		card: '#f7f9fd',
		'card-foreground': '#24304a',
		popover: '#fbfcfe',
		'popover-foreground': '#24304a',
		primary: '#1f3f7a',
		'primary-foreground': '#f0f5fd',
		secondary: '#dfe7f4',
		'secondary-foreground': '#2b3b5c',
		muted: '#e3eaf5',
		'muted-foreground': '#5a6a88',
		accent: '#d9e4f6',
		'accent-foreground': '#1f3f7a',
		destructive: '#b3362f',
		border: '#d3ddef',
		input: '#c8d5ea',
		ring: '#4a71b5',
		radius: '0.625rem'
	},
	dark: {
		background: '#101a2b',
		foreground: '#c3cede',
		card: '#16213a',
		'card-foreground': '#c3cede',
		popover: '#1a2745',
		'popover-foreground': '#c3cede',
		primary: '#8fb0dd',
		'primary-foreground': '#0e1830',
		secondary: '#1d2a4a',
		'secondary-foreground': '#cdd9ec',
		muted: '#1a2440',
		'muted-foreground': '#8598b8',
		accent: '#22325a',
		'accent-foreground': '#d3def0',
		destructive: '#e08585',
		border: '#263456',
		input: '#2c3c62',
		ring: '#8fb0dd',
		radius: '0.625rem'
	}
};
export const WARM_PAPER_THEME: ThemeDefinition = {
	id: 'warm-paper',
	name: 'Warm Paper',
	light: {
		background: '#f7f1e3',
		foreground: '#3b352a',
		card: '#fcf7ec',
		'card-foreground': '#3b352a',
		popover: '#fefbf4',
		'popover-foreground': '#3b352a',
		primary: '#6f5b38',
		'primary-foreground': '#faf5ea',
		secondary: '#efe6d2',
		'secondary-foreground': '#4a4232',
		muted: '#f0e8d6',
		'muted-foreground': '#6f6552',
		accent: '#eadfc6',
		'accent-foreground': '#4a4232',
		destructive: '#a83a2e',
		border: '#e2d7bd',
		input: '#d9cba9',
		ring: '#a08d64',
		radius: '0.5rem'
	},
	dark: {
		background: '#201b14',
		foreground: '#d6cbb8',
		card: '#262019',
		'card-foreground': '#d6cbb8',
		popover: '#2b241b',
		'popover-foreground': '#d6cbb8',
		primary: '#d3b981',
		'primary-foreground': '#241d10',
		secondary: '#322a20',
		'secondary-foreground': '#ded2ba',
		muted: '#2c251c',
		'muted-foreground': '#9c8f77',
		accent: '#3a3023',
		'accent-foreground': '#e2d6bd',
		destructive: '#d98a7a',
		border: '#3a3125',
		input: '#443a2b',
		ring: '#b09767',
		radius: '0.5rem'
	}
};
export const CATPPUCCIN_THEME: ThemeDefinition = {
	id: 'catppuccin',
	name: 'Catppuccin',
	light: {
		background: '#eff1f5',
		foreground: '#4c4f69',
		card: '#e6e9ef',
		'card-foreground': '#4c4f69',
		popover: '#dce0e8',
		'popover-foreground': '#4c4f69',
		primary: '#8839ef',
		'primary-foreground': '#eff1f5',
		secondary: '#dce0e8',
		'secondary-foreground': '#5c5f78',
		muted: '#e6e9ef',
		'muted-foreground': '#64677d',
		accent: '#ccd0da',
		'accent-foreground': '#4c4f69',
		destructive: '#d20f39',
		border: '#ccd0da',
		input: '#bcc0cc',
		ring: '#8839ef',
		radius: '0.625rem'
	},
	dark: {
		background: '#1e1e2e',
		foreground: '#cdd6f4',
		card: '#181825',
		'card-foreground': '#cdd6f4',
		popover: '#11111b',
		'popover-foreground': '#cdd6f4',
		primary: '#cba6f7',
		'primary-foreground': '#1e1e2e',
		secondary: '#313244',
		'secondary-foreground': '#cdd6f4',
		muted: '#313244',
		'muted-foreground': '#9399b2',
		accent: '#45475a',
		'accent-foreground': '#cdd6f4',
		destructive: '#f38ba8',
		border: '#45475a',
		input: '#585b70',
		ring: '#cba6f7',
		radius: '0.625rem'
	}
};
export const DRACULA_THEME: ThemeDefinition = {
	id: 'dracula',
	name: 'Dracula',
	light: {
		background: '#f5f2fa',
		foreground: '#33323f',
		card: '#fbf9fd',
		'card-foreground': '#33323f',
		popover: '#fdfcff',
		'popover-foreground': '#33323f',
		primary: '#7c3aed',
		'primary-foreground': '#f7f4fd',
		secondary: '#ebe5f5',
		'secondary-foreground': '#3f3a52',
		muted: '#eeeaf6',
		'muted-foreground': '#6d6785',
		accent: '#e4dcf2',
		'accent-foreground': '#3f3a52',
		destructive: '#bd2845',
		border: '#ded6ec',
		input: '#d2c8e6',
		ring: '#9a6cf0',
		radius: '0.625rem'
	},
	dark: {
		background: '#282a36',
		foreground: '#f8f8f2',
		card: '#2b2d3a',
		'card-foreground': '#f8f8f2',
		popover: '#21222d',
		'popover-foreground': '#f8f8f2',
		primary: '#bd93f9',
		'primary-foreground': '#1f1f2a',
		secondary: '#3a3d4d',
		'secondary-foreground': '#f8f8f2',
		muted: '#343946',
		'muted-foreground': '#98a1c9',
		accent: '#44475a',
		'accent-foreground': '#f8f8f2',
		destructive: '#ff6e6e',
		border: '#44475a',
		input: '#4c4f63',
		ring: '#bd93f9',
		radius: '0.625rem'
	}
};

export const BUILTIN_THEMES: ThemeDefinition[] = [
	SOFT_THEME,
	CLASSIC_THEME,
	MATRIX_THEME,
	CYPHERPUNK_THEME,
	NAVY_THEME,
	WARM_PAPER_THEME,
	CATPPUCCIN_THEME,
	DRACULA_THEME
];

export const DEFAULT_THEME_ID = SOFT_THEME.id;
