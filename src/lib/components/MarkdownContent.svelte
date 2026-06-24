<script lang="ts" module>
	import { parseMarkdown, type MarkdownBlock } from '$lib/markdown/parseMarkdown';

	function blockKey(block: MarkdownBlock): string {
		if (block.type === 'heading') return `heading:${block.level}:${block.text}`;
		if (block.type === 'paragraph') return `paragraph:${block.text}`;
		return `list:${block.items.join('|')}`;
	}
</script>

<script lang="ts">
	import { cn } from '$lib/utils';

	let {
		source = '',
		blocks: blocksProp,
		class: className
	}: {
		source?: string;
		blocks?: MarkdownBlock[];
		class?: string;
	} = $props();

	const blocks = $derived(blocksProp ?? parseMarkdown(source));
</script>

{#if blocks.length}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<article class={cn('prose max-w-none prose-neutral dark:prose-invert', className)}>
		{#each blocks as block (blockKey(block))}
			{#if block.type === 'heading'}
				{#if block.level === 1}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<h1>{@html block.text}</h1>
				{:else if block.level === 2}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<h2>{@html block.text}</h2>
				{:else}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<h3>{@html block.text}</h3>
				{/if}
			{:else if block.type === 'paragraph'}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<p>{@html block.text}</p>
			{:else}
				<ul>
					{#each block.items as item (item)}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<li>{@html item}</li>
					{/each}
				</ul>
			{/if}
		{/each}
	</article>
{/if}
