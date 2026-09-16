<script lang="ts">
	import ThemeEditor from '$lib/components/appearance/ThemeEditor.svelte';
	import { activeTheme, appearance, closeThemeEditor, openThemeEditor } from './appearance.svelte';
	import type { ThemeDefinition } from './types';

	// Mirrors the appearance page's editor swap: same conditional render and
	// same onsaved/oncancel state clears, driven by the module-level editor
	// state so drafts survive remounts (i.e. route navigation).
	export function openEditor(source?: ThemeDefinition) {
		openThemeEditor(source ?? activeTheme());
	}
</script>

{#if appearance.themeEditor}
	<ThemeEditor
		editor={appearance.themeEditor}
		oncancel={closeThemeEditor}
		onsaved={closeThemeEditor}
	/>
{/if}
