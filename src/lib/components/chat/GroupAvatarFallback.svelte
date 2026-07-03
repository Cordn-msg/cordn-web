<script lang="ts">
	/**
	 * Shared group-avatar fallback: the group's emoji icon when set, otherwise
	 * the Cordn logo (light + dark variants). Single source of truth so the
	 * sidebar, chat header, group info page, and welcome cards can't drift —
	 * and so an image-less group (or one hidden while "autoload media" is off)
	 * shows the icon or logo instead of an empty disc.
	 */
	let { icon, logoClass = 'h-1/2 w-1/2' }: { icon?: string; logoClass?: string } = $props();
</script>

{#if icon}
	{icon}
{:else}
	<img src="/cordn-logo-black.svg" alt="Cordn" class="{logoClass} object-contain dark:hidden" />
	<img src="/cordn-logo.svg" alt="Cordn" class="hidden {logoClass} object-contain dark:block" />
{/if}
