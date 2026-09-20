<script lang="ts">
	import { parseMarkdown, type MarkdownBlock } from '$lib/markdown/parseMarkdown';
	import { cn } from '$lib/utils';
	import MarkdownInline from './MarkdownInline.svelte';

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
	<article class={cn('prose max-w-none prose-neutral dark:prose-invert', className)}>
		{#each blocks as block, index (index)}
			{#if block.type === 'heading'}
				{#if block.level === 1}
					<h1><MarkdownInline nodes={block.inline} /></h1>
				{:else if block.level === 2}
					<h2><MarkdownInline nodes={block.inline} /></h2>
				{:else}
					<h3><MarkdownInline nodes={block.inline} /></h3>
				{/if}
			{:else if block.type === 'paragraph'}
				<p><MarkdownInline nodes={block.inline} /></p>
			{:else if block.type === 'list'}
				{#if block.ordered}
					<ol>
						{#each block.items as item, itemIndex (itemIndex)}
							<li><MarkdownInline nodes={item} /></li>
						{/each}
					</ol>
				{:else}
					<ul>
						{#each block.items as item, itemIndex (itemIndex)}
							<li><MarkdownInline nodes={item} /></li>
						{/each}
					</ul>
				{/if}
			{:else if block.type === 'code'}
				<pre><code>{block.text}</code></pre>
			{:else}
				<blockquote><MarkdownInline nodes={block.inline} /></blockquote>
			{/if}
		{/each}
	</article>
{/if}
