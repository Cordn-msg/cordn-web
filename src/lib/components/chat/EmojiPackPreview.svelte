<script lang="ts">
	import CustomEmoji from './CustomEmoji.svelte';
	import type { EmojiPack } from '$lib/chat/emoji';

	/** A bounded pack grid shared by settings and chat cards; +N expands in place. */
	let { pack, gateAutoLoad = true }: { pack: EmojiPack; gateAutoLoad?: boolean } = $props();

	const COLLAPSED_LIMIT = 8;
	// Coordinate-keyed so reusing the component for another pack starts collapsed.
	let expandedFor = $state<string | null>(null);
	const expanded = $derived(expandedFor === pack.coordinate);
	const shown = $derived(expanded ? pack.emoji : pack.emoji.slice(0, COLLAPSED_LIMIT));
	const remaining = $derived(Math.max(0, pack.emoji.length - COLLAPSED_LIMIT));
	const canExpand = $derived(pack.emoji.length > COLLAPSED_LIMIT);
</script>

<span class="flex min-w-0 flex-wrap gap-1.5">
	{#each shown as emoji (emoji.name)}
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card"
			title={`:${emoji.name}:`}
		>
			<CustomEmoji
				display={{ name: emoji.name, url: emoji.url }}
				{gateAutoLoad}
				sizeClass="size-6"
			/>
		</span>
	{/each}
	{#if canExpand}
		<button
			type="button"
			class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
			aria-expanded={expanded}
			aria-label={expanded ? 'Show fewer emoji' : `Show all ${pack.emoji.length} emoji`}
			title={expanded ? 'Show fewer' : `Show all ${pack.emoji.length} emoji`}
			onclick={() => (expandedFor = expanded ? null : pack.coordinate)}
		>
			{expanded ? 'Less' : `+${remaining}`}
		</button>
	{/if}
</span>
