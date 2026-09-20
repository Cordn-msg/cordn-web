<script lang="ts">
	/**
	 * Renders parsed markdown blocks inside a chat bubble with chat-tailored
	 * styling (headings collapse to bold lines, quotes/list spacing tuned for
	 * bubbles). Consumes pre-parsed blocks from the render cache — no parsing
	 * happens here.
	 */
	import ChatMarkdownInline from './ChatMarkdownInline.svelte';
	import { cn } from '$lib/utils';
	import { MESSAGE_TEXT_WRAP_CLASS } from '$lib/chat/messageTextClasses';
	import type { MarkdownBlock } from '$lib/markdown/parseMarkdown';

	let {
		blocks,
		messageId,
		isOwn = false
	}: { blocks: MarkdownBlock[]; messageId: string; isOwn?: boolean } = $props();
</script>

<div class="max-w-full min-w-0 space-y-1.5">
	{#each blocks as block, index (index)}
		{#if block.type === 'paragraph'}
			<p class={MESSAGE_TEXT_WRAP_CLASS}>
				<ChatMarkdownInline nodes={block.inline} {messageId} {isOwn} />
			</p>
		{:else if block.type === 'heading'}
			<p class={cn('font-semibold', MESSAGE_TEXT_WRAP_CLASS)}>
				<ChatMarkdownInline nodes={block.inline} {messageId} {isOwn} />
			</p>
		{:else if block.type === 'list'}
			{#if block.ordered}
				<ol class={cn('list-decimal space-y-0.5 pl-5', MESSAGE_TEXT_WRAP_CLASS)}>
					{#each block.items as item, itemIndex (itemIndex)}
						<li class="list-outside">
							<ChatMarkdownInline nodes={item} {messageId} {isOwn} />
						</li>
					{/each}
				</ol>
			{:else}
				<ul class={cn('list-disc space-y-0.5 pl-5', MESSAGE_TEXT_WRAP_CLASS)}>
					{#each block.items as item, itemIndex (itemIndex)}
						<li class="list-outside">
							<ChatMarkdownInline nodes={item} {messageId} {isOwn} />
						</li>
					{/each}
				</ul>
			{/if}
		{:else if block.type === 'code'}
			<pre
				class={cn(
					'max-w-full overflow-x-auto rounded-lg p-2 text-xs leading-relaxed',
					isOwn ? 'bg-primary-foreground/10' : 'bg-muted'
				)}><code class="block whitespace-pre">{block.text}</code></pre>
		{:else}
			<blockquote
				class={cn(
					'max-w-full border-l-2 pl-2',
					isOwn ? 'border-primary-foreground/40' : 'border-border'
				)}
			>
				<ChatMarkdownInline nodes={block.inline} {messageId} {isOwn} />
			</blockquote>
		{/if}
	{/each}
</div>
