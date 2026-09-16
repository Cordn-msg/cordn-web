<script lang="ts">
	import {
		activeTheme,
		appearance,
		forkTheme,
		isHexColor,
		parseThemeJson,
		previewTheme,
		saveCustomTheme
	} from '$lib/themes/appearance.svelte';
	import type { ThemeDefinition, ThemeTokenKey } from '$lib/themes/types';
	import { THEME_TOKEN_GROUPS, THEME_TOKEN_KEYS } from '$lib/themes/types';
	import { CONTRAST_PAIRS, contrastForSet } from '$lib/themes/contrast';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Send from '@lucide/svelte/icons/send';
	import Dices from '@lucide/svelte/icons/dices';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Copy from '@lucide/svelte/icons/copy';
	import Lock from '@lucide/svelte/icons/lock';
	import LockOpen from '@lucide/svelte/icons/lock-open';
	import { Slider } from '$lib/components/ui/slider';
	import Textarea from '$lib/components/ui/textarea/textarea.svelte';
	import { BUILTIN_THEMES } from '$lib/themes/builtin';
	import { randomTheme } from '$lib/themes/random';
	import { toast } from 'svelte-sonner';

	const VARIANTS = ['light', 'dark'] as const;
	type Variant = (typeof VARIANTS)[number];

	let { source, oncancel, onsaved = () => {} } = $props();

	// Fork semantics: only built-ins fork into a new custom theme; customs and
	// brand-new unsaved drafts (from "New theme") edit in place.
	// Deliberate snapshot of `source` — a draft must not react to later changes.
	const isBuiltIn = BUILTIN_THEMES.some((t) => t.id === source.id);
	/* svelte-ignore state_referenced_locally */
	const draft = $state(
		isBuiltIn
			? forkTheme(source)
			: { ...source, light: { ...source.light }, dark: { ...source.dark } }
	);

	// Apply the draft once on open so the editor is self-contained regardless
	// of which theme was active when it opened (setup-time call, not teardown).
	previewTheme(draft);

	let mode = $state<Variant>('light');
	// Radius is shared between variants unless the user explicitly unlinks it.
	let radiusLocked = $state(true);
	let openGroups = $state<Record<string, boolean>>(
		Object.fromEntries([
			...THEME_TOKEN_GROUPS.map((g, i) => [g.label, i === 0]),
			['Advanced', false]
		])
	);

	// Live preview is applied explicitly in commit()/cancel()/save() instead of
	// via $effect/onDestroy: Svelte teardown callbacks run with stale $state
	// reads in this flush path, which clobbered freshly-saved themes (the
	// restore-on-destroy wrote the pre-save theme back after setTheme).

	function commit(key: ThemeTokenKey, value: string) {
		draft[mode][key] = value;
		if (key === 'radius' && radiusLocked) {
			draft.light.radius = value;
			draft.dark.radius = value;
		}
		previewTheme(draft);
		syncJson();
	}

	/** `source` is the last saved state: the built-in values for a fork, the
	 * stored values for an in-place custom edit. */
	function isChanged(key: ThemeTokenKey): boolean {
		return draft[mode][key] !== source[mode][key];
	}
	function revert(key: ThemeTokenKey) {
		commit(key, source[mode][key]);
	}
	function radiusToRem(v: string): number {
		const n = parseFloat(v);
		if (!Number.isFinite(n)) return 0.625;
		return v.trim().endsWith('px') ? n / 16 : n;
	}

	// --- Advanced: edit the theme as JSON (same object Export/Import uses) ---
	function themeToJson(t: ThemeDefinition): string {
		return JSON.stringify(
			{ format: 'cordn-theme', version: 1, name: t.name, light: t.light, dark: t.dark },
			null,
			'\t'
		);
	}
	let jsonText = $state(themeToJson(draft));
	let jsonError = $state('');
	let jsonDirty = false;

	/** Re-generate the JSON text after token/name edits unless mid-edit there. */
	function syncJson() {
		if (!jsonDirty) jsonText = themeToJson(draft);
	}

	function applyJson() {
		const parsed = parseThemeJson(jsonText);
		if (!parsed) {
			jsonError = 'Not a valid theme JSON object — check the syntax and color values.';
			return;
		}
		jsonError = '';
		if (parsed.name) draft.name = parsed.name;
		for (const key of THEME_TOKEN_KEYS) {
			const light = parsed.light?.[key];
			if (light) draft.light[key] = light;
			const dark = parsed.dark?.[key];
			if (dark) draft.dark[key] = dark;
		}
		jsonDirty = false;
		jsonText = themeToJson(draft); // normalize what was pasted
		previewTheme(draft);
	}

	async function copyJson() {
		await navigator.clipboard.writeText(jsonText);
		toast.success('Theme JSON copied');
	}

	/** Replace the draft with a random AA-gated theme; keeps the draft id so
	 * save semantics (fork vs in-place) are unchanged. */
	function roll() {
		const t = randomTheme();
		draft.name = t.name;
		draft.light = t.light;
		draft.dark = t.dark;
		jsonDirty = false;
		syncJson();
		previewTheme(draft);
	}

	function hexInputHandler(key: ThemeTokenKey) {
		return (event: Event) => {
			const input = event.currentTarget as HTMLInputElement;
			const v = input.value.trim();
			if (isHexColor(v)) commit(key, v);
		};
	}
	function hexBlurHandler(key: ThemeTokenKey) {
		return (event: Event) => {
			(event.currentTarget as HTMLInputElement).value = draft[mode][key];
		};
	}

	function pickerValue(key: ThemeTokenKey) {
		const v = draft[mode][key];
		// Native picker is 6-digit only; show the RGB part of alpha colors.
		return v.length === 9 ? v.slice(0, 7) : v.length === 4 ? v + v.slice(1) : v;
	}
	function pickerHandler(key: ThemeTokenKey) {
		return (event: Event) => {
			const picked = (event.currentTarget as HTMLInputElement).value;
			const v = draft[mode][key];
			// Preserve any alpha byte the picker cannot represent.
			commit(key, v.length === 9 ? picked + v.slice(7) : picked);
		};
	}

	function save() {
		draft.name = draft.name.trim() || forkName(source);
		saveCustomTheme({ ...draft, light: { ...draft.light }, dark: { ...draft.dark } });
		toast.success(`Saved theme "${draft.name}"`);
		onsaved();
	}
	function forkName(t: ThemeDefinition) {
		return `${t.name} (custom)`.slice(0, 40);
	}
	function cancel() {
		previewTheme(activeTheme());
		oncancel();
	}
</script>

{#snippet revertBtn(key: ThemeTokenKey, label: string)}
	<button
		type="button"
		class="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground
			{isChanged(key) ? '' : 'invisible'}"
		title="Reset to {source[mode][key]}"
		aria-label="Reset {label}"
		onclick={() => revert(key)}
	>
		<RotateCcw class="size-3.5" />
	</button>
{/snippet}

<div class="space-y-4">
	<div class="space-y-2">
		<Label for="cordn-theme-name">Theme name</Label>
		<Input
			id="cordn-theme-name"
			maxlength={40}
			value={draft.name}
			oninput={(e) => {
				draft.name = (e.currentTarget as HTMLInputElement).value;
				syncJson();
			}}
		/>
		<p class="text-xs text-muted-foreground">
			{#if isBuiltIn}
				Saving creates a new custom theme — the built-in stays untouched.
			{:else if !appearance.customThemes.some((t) => t.id === source.id)}
				A brand-new custom theme — it will appear in your theme list once saved.
			{/if}
		</p>
	</div>

	<div class="flex items-center justify-between gap-2">
		<div
			class="inline-flex rounded-lg border border-border p-1"
			role="tablist"
			aria-label="Variant"
		>
			{#each VARIANTS as m (m)}
				<button
					type="button"
					role="tab"
					aria-selected={mode === m}
					class="rounded-md px-3 py-1 text-sm font-medium transition-colors
					{mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (mode = m)}
				>
					{m === 'light' ? 'Light' : 'Dark'} variant
				</button>
			{/each}
		</div>
		<Button
			type="button"
			variant="outline"
			size="sm"
			onclick={roll}
			title="Generate a random color scheme"
		>
			<Dices class="size-4" /> Roll
		</Button>
	</div>

	<div class="flex flex-wrap gap-2">
		{#each CONTRAST_PAIRS as pair (pair.label)}
			{@const ratio = contrastForSet(draft[mode], pair)}
			<span
				class="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs
					{ratio === null
					? 'text-muted-foreground'
					: ratio >= 4.5
						? 'text-emerald-700 dark:text-emerald-400'
						: 'text-amber-700 dark:text-amber-400'}"
			>
				{pair.label}
				{#if ratio === null}
					n/a
				{:else}
					{ratio.toFixed(1)}:1{ratio < 4.5 ? ' — low' : ''}
				{/if}
			</span>
		{/each}
	</div>

	<!-- Tiny mock chat so token edits read as "how chats will look". All classes
	     are theme tokens, so it live-updates with the draft preview. -->
	<div class="rounded-xl border border-border bg-card p-3" aria-hidden="true">
		<div class="mb-3 flex items-center gap-2 border-b border-border pb-2.5">
			<div class="size-6 rounded-full bg-accent"></div>
			<div class="h-2 w-20 rounded-full bg-muted"></div>
			<div class="ml-auto h-2 w-8 rounded-full bg-muted"></div>
		</div>
		<div class="space-y-2">
			<div class="max-w-[75%] rounded-lg bg-muted px-3 py-1.5 text-sm text-foreground">
				Have you seen the new themes?
			</div>
			<div
				class="ml-auto max-w-[75%] rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground"
			>
				Just switched — much easier on the eyes
			</div>
			<div class="max-w-[60%] rounded-lg bg-muted px-3 py-1.5 text-sm text-muted-foreground">
				Send me yours next
			</div>
		</div>
		<div
			class="mt-3 flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-2"
		>
			<span class="text-sm text-muted-foreground">Message…</span>
			<div
				class="ml-auto flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground"
			>
				<Send class="size-3.5" />
			</div>
		</div>
	</div>

	{#each THEME_TOKEN_GROUPS as group (group.label)}
		<Collapsible.Root bind:open={openGroups[group.label]}>
			<Collapsible.Trigger
				class="flex w-full items-center justify-between rounded-lg px-1 py-2 text-sm font-medium hover:bg-muted/50"
			>
				{group.label}
				<ChevronDown
					class="size-4 text-muted-foreground transition-transform {openGroups[group.label]
						? 'rotate-180'
						: ''}"
				/>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<div class="space-y-2 px-1 pb-3">
					{#each group.tokens as token (token.key)}
						{#if token.key === 'radius'}
							<div class="flex items-center justify-between gap-3">
								<span class="shrink-0 text-sm">{token.label}</span>
								<div class="flex min-w-0 items-center gap-2">
									<span class="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground">
										{radiusToRem(draft[mode][token.key]).toFixed(2)}rem
									</span>
									<button
										type="button"
										aria-pressed={radiusLocked}
										title={radiusLocked
											? 'Corner radius is shared between light and dark. Click to unlink.'
											: 'Corner radius is separate per variant. Click to share one value.'}
										class="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground
											{radiusLocked ? 'text-foreground' : ''}"
										onclick={() => (radiusLocked = !radiusLocked)}
									>
										{#if radiusLocked}
											<Lock class="size-3.5" />
										{:else}
											<LockOpen class="size-3.5" />
										{/if}
									</button>
									<Slider
										type="single"
										min={0}
										max={2}
										step={0.05}
										class="w-32 sm:w-40"
										value={radiusToRem(draft[mode][token.key])}
										onValueChange={(v) => commit(token.key, `${Number(v.toFixed(2))}rem`)}
										aria-label={token.label}
									/>
									{@render revertBtn(token.key, token.label)}
								</div>
							</div>
						{:else}
							<div class="flex items-center justify-between gap-3">
								<span class="text-sm">{token.label}</span>
								<div class="flex items-center gap-2">
									<Input
										class="w-28 font-mono text-xs"
										value={draft[mode][token.key]}
										oninput={hexInputHandler(token.key)}
										onblur={hexBlurHandler(token.key)}
										aria-label={token.label}
									/>
									<input
										type="color"
										class="size-8 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
										value={pickerValue(token.key)}
										oninput={pickerHandler(token.key)}
										aria-label="Pick {token.label} color"
									/>
									{@render revertBtn(token.key, token.label)}
								</div>
							</div>
						{/if}
					{/each}
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	{/each}

	<Collapsible.Root bind:open={openGroups['Advanced']}>
		<Collapsible.Trigger
			class="flex w-full items-center justify-between rounded-lg px-1 py-2 text-sm font-medium hover:bg-muted/50"
		>
			Advanced — edit as JSON
			<ChevronDown
				class="size-4 text-muted-foreground transition-transform {openGroups['Advanced']
					? 'rotate-180'
					: ''}"
			/>
		</Collapsible.Trigger>
		<Collapsible.Content>
			<div class="space-y-2 px-1 pb-3">
				<p class="text-xs text-muted-foreground">
					This JSON object <em>is</em> the theme. Edit it directly, or copy it and modify it in your own
					text editor or with the help of an AI agent — then paste it back and apply to preview it live.
					Apply only changes the draft; save as usual to keep it.
				</p>
				<Textarea
					class="min-h-56 font-mono text-xs"
					bind:value={jsonText}
					oninput={() => (jsonDirty = true)}
					aria-label="Theme JSON"
					spellcheck="false"
				/>
				{#if jsonError}
					<p class="text-xs text-destructive">{jsonError}</p>
				{/if}
				<div class="flex justify-end gap-2">
					<Button type="button" variant="outline" onclick={copyJson}>
						<Copy class="size-4" /> Copy JSON
					</Button>
					<Button type="button" onclick={applyJson}>Apply JSON</Button>
				</div>
			</div>
		</Collapsible.Content>
	</Collapsible.Root>

	<div class="flex justify-end gap-2 border-t border-border pt-4">
		<Button type="button" variant="outline" onclick={cancel}>Cancel</Button>
		<Button type="button" onclick={save}>Save theme</Button>
	</div>
</div>
