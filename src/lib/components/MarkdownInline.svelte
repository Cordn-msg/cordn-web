<script lang="ts">
	/**
	 * Renders inline markdown nodes for trusted prose pages (news, why).
	 * Recursive by self-import. Text nodes are Svelte text nodes — escaped by
	 * construction; no {@html} anywhere.
	 */
	import Self from './MarkdownInline.svelte';
	import type { MarkdownInlineNode } from '$lib/markdown/parseMarkdown';

	let { nodes }: { nodes: MarkdownInlineNode[] } = $props();
</script>

{#each nodes as node, index (index)}
	{#if node.type === 'text'}
		{node.text}
	{:else if node.type === 'code'}
		<code>{node.text}</code>
	{:else if node.type === 'strong'}
		<strong><Self nodes={node.children} /></strong>
	{:else if node.type === 'em'}
		<em><Self nodes={node.children} /></em>
	{:else if node.type === 'del'}
		<del><Self nodes={node.children} /></del>
	{:else if node.type === 'link'}
		<!-- Hrefs are parser-validated to absolute http(s)/mailto, so router-relative
			 navigation (the rule's concern) cannot occur here. -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a href={node.href}>{node.text}</a>
	{:else if node.type === 'softbreak'}
		<span> </span>
	{/if}
{/each}
