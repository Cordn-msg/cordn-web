<script lang="ts">
	import { getCollapseLongMessages } from '$lib/services/chatComposerSettings.svelte';
	import { cn } from '$lib/utils';

	/**
	 * Wraps a message/embed body and clamps it when long (the README's "inline
	 * never grows unbounded" contract). Gate is a char count, not DOM
	 * measurement — no resize observers, and the virtualizer's measureElement
	 * absorbs the height change on toggle. Shared by chat rows and embedded
	 * nostr events; the knob lives in Chat behavior settings.
	 */
	let {
		length,
		isOwn = false,
		children
	}: { length: number; isOwn?: boolean; children: import('svelte').Snippet } = $props();

	const COLLAPSE_CHAR_THRESHOLD = 600;

	const collapsible = $derived.by(() => {
		// Reads reactive module state so the setting applies instantly.
		const enabled = getCollapseLongMessages();
		return enabled && length > COLLAPSE_CHAR_THRESHOLD;
	});
	let expanded = $state(false);
</script>

{#if collapsible && !expanded}
	<!-- Static class: Tailwind only generates classes it can see in source. -->
	<div class="line-clamp-12">{@render children()}</div>
{:else}
	{@render children()}
{/if}
{#if collapsible}
	<button
		type="button"
		class={cn(
			'mt-1 text-xs font-medium underline-offset-2 hover:underline',
			isOwn ? 'text-primary-foreground/80' : 'text-muted-foreground'
		)}
		onclick={() => (expanded = !expanded)}
	>
		{expanded ? 'Show less' : 'Show more'}
	</button>
{/if}
