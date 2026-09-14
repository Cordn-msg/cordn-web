/**
 * Theme token model. A theme is exactly the set of shadcn-style semantic CSS
 * variables the UI consumes (via Tailwind's `@theme inline` mapping in
 * `src/routes/layout.css`) — plus `--radius`. Charts and sidebar tokens are
 * unused in this app and intentionally excluded; layout.css keeps their
 * default values as inert infrastructure.
 */

export type ThemeTokenKey =
	| 'background'
	| 'foreground'
	| 'card'
	| 'card-foreground'
	| 'popover'
	| 'popover-foreground'
	| 'primary'
	| 'primary-foreground'
	| 'secondary'
	| 'secondary-foreground'
	| 'muted'
	| 'muted-foreground'
	| 'accent'
	| 'accent-foreground'
	| 'destructive'
	| 'border'
	| 'input'
	| 'ring'
	| 'radius';

export type ThemeTokenSet = Record<ThemeTokenKey, string>;

export interface ThemeDefinition {
	id: string;
	name: string;
	light: ThemeTokenSet;
	dark: ThemeTokenSet;
}

export interface ThemeTokenMeta {
	key: ThemeTokenKey;
	label: string;
}

export interface ThemeTokenGroup {
	label: string;
	tokens: ThemeTokenMeta[];
}

/** Editor grouping. `radius` is a CSS length, everything else a CSS color. */
export const THEME_TOKEN_GROUPS: ThemeTokenGroup[] = [
	{
		label: 'Surfaces',
		tokens: [
			{ key: 'background', label: 'Background' },
			{ key: 'card', label: 'Card' },
			{ key: 'popover', label: 'Popover' },
			{ key: 'secondary', label: 'Secondary' },
			{ key: 'accent', label: 'Accent' },
			{ key: 'muted', label: 'Muted' }
		]
	},
	{
		label: 'Text',
		tokens: [
			{ key: 'foreground', label: 'Foreground' },
			{ key: 'card-foreground', label: 'On card' },
			{ key: 'popover-foreground', label: 'On popover' },
			{ key: 'secondary-foreground', label: 'On secondary' },
			{ key: 'accent-foreground', label: 'On accent' },
			{ key: 'muted-foreground', label: 'Muted text' }
		]
	},
	{
		label: 'Primary',
		tokens: [
			{ key: 'primary', label: 'Primary' },
			{ key: 'primary-foreground', label: 'On primary' }
		]
	},
	{
		label: 'Status',
		tokens: [{ key: 'destructive', label: 'Destructive' }]
	},
	{
		label: 'Structure',
		tokens: [
			{ key: 'border', label: 'Border' },
			{ key: 'input', label: 'Input' },
			{ key: 'ring', label: 'Focus ring' },
			{ key: 'radius', label: 'Corner radius' }
		]
	}
];

export const THEME_TOKEN_KEYS: ThemeTokenKey[] = THEME_TOKEN_GROUPS.flatMap((g) =>
	g.tokens.map((t) => t.key)
);
