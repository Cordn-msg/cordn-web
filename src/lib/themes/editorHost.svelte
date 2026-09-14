<script lang="ts">
	import ThemeEditor from '$lib/components/appearance/ThemeEditor.svelte';
	import { activeTheme } from '$lib/themes/appearance.svelte';
	import type { ThemeDefinition } from '$lib/themes/types';

	// Mirrors the appearance page's editor swap: same conditional render and
	// same onsaved/ oncancel state clears.
	let editing = $state<ThemeDefinition | null>(null);

	export function openEditor(source?: ThemeDefinition) {
		editing = source ?? activeTheme();
	}
</script>

{#if editing}
	<ThemeEditor
		source={editing}
		oncancel={() => (editing = null)}
		onsaved={() => (editing = null)}
	/>
{/if}
