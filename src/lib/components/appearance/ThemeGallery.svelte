<script lang="ts">
	import { BUILTIN_THEMES } from '$lib/themes/builtin';
	import {
		appearance,
		deleteCustomTheme,
		exportTheme,
		forkTheme,
		importTheme,
		saveCustomTheme,
		setTheme
	} from '$lib/themes/appearance.svelte';
	import type { ThemeDefinition, ThemeTokenSet } from '$lib/themes/types';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import ImportIcon from '@lucide/svelte/icons/upload';
	import MoreIcon from '@lucide/svelte/icons/more-horizontal';
	import { toast } from 'svelte-sonner';

	let { onedit = (_theme: ThemeDefinition) => {} } = $props();

	const allThemes = $derived([...BUILTIN_THEMES, ...appearance.customThemes]);

	function handleImport(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			const theme = importTheme(String(reader.result ?? ''));
			if (theme) toast.success(`Imported theme "${theme.name}"`);
			else toast.error('Not a valid Cordn theme file');
		};
		reader.readAsText(file);
	}

	function duplicate(theme: ThemeDefinition) {
		const copy = forkTheme(theme);
		saveCustomTheme(copy);
		onedit(copy);
	}

	function remove(theme: ThemeDefinition) {
		if (confirm(`Delete theme "${theme.name}"?`)) deleteCustomTheme(theme.id);
	}

	/** Small swatch strip previewing a theme variant. */
	function swatches(set: ThemeTokenSet) {
		return [set.background, set.card, set.primary, set['muted-foreground'], set.border];
	}
</script>

<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
	{#each allThemes as theme (theme.id)}
		{@const isCustom = appearance.customThemes.some((t) => t.id === theme.id)}
		{@const variants: [string, ThemeTokenSet][] = [
			['Light', theme.light],
			['Dark', theme.dark]
		]}
		<div class="relative">
			<button
				type="button"
				class="w-full rounded-2xl border p-4 text-left transition-colors hover:bg-muted/50
					{appearance.activeThemeId === theme.id
					? 'border-primary bg-muted/40 ring-2 ring-ring'
					: 'border-border'}
					{isCustom ? 'pr-12' : ''}"
				onclick={() => setTheme(theme.id)}
			>
				<div class="flex items-center gap-2">
					<span class="truncate font-medium">{theme.name}</span>
					<span
						class="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
					>
						{isCustom ? 'Custom' : 'Built-in'}
					</span>
				</div>
				<div class="mt-3 space-y-1.5">
					{#each variants as [label, set] (label)}
						<div class="flex items-center gap-2">
							<span class="w-9 shrink-0 text-xs text-muted-foreground">{label}</span>
							<div class="flex h-5 flex-1 overflow-hidden rounded-md border border-border">
								{#each swatches(set) as color, i (i)}
									<div class="flex-1" style="background: {color}"></div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</button>

			{#if isCustom}
				<div class="absolute top-3 right-3">
					<DropdownMenu.Root>
						<DropdownMenu.Trigger
							class="rounded-lg border border-border bg-background p-1.5 shadow-sm"
							aria-label="Theme actions"
						>
							<MoreIcon class="size-4" />
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item onclick={() => duplicate(theme)}>Duplicate</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => exportTheme(theme)}>Export</DropdownMenu.Item>
							<DropdownMenu.Item class="text-destructive" onclick={() => remove(theme)}>
								Delete
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>
			{/if}
		</div>
	{/each}
</div>

<input
	id="cordn-theme-import"
	type="file"
	accept="application/json,.json"
	class="hidden"
	onchange={handleImport}
/>
<Button
	type="button"
	variant="outline"
	class="mt-3"
	onclick={() => document.getElementById('cordn-theme-import')?.click()}
>
	<ImportIcon class="size-4" /> Import theme
</Button>
