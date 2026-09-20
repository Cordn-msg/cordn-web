<script lang="ts">
	/**
	 * Renders inline markdown nodes inside a chat bubble. Recursive by
	 * self-import. Text nodes expand through the existing mention/link/media
	 * pipeline (MessageParts) so npub mentions keep working inside markdown;
	 * markdown links route through the same safe-open path as plain links.
	 */
	import Self from './ChatMarkdownInline.svelte';
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import { openMessageLink } from '$lib/utils/groupShareLink';
	import { cn } from '$lib/utils';
	import { MESSAGE_LINK_WRAP_CLASS } from '$lib/chat/messageTextClasses';
	import type { MarkdownInlineNode } from '$lib/markdown/parseMarkdown';

	let {
		nodes,
		messageId,
		isOwn = false
	}: { nodes: MarkdownInlineNode[]; messageId: string; isOwn?: boolean } = $props();
</script>

{#each nodes as node, index (index)}
	{#if node.type === 'text'}
		<MessageParts {messageId} text={node.text} {isOwn} />
	{:else if node.type === 'code'}
		<code
			class={cn(
				'rounded px-1 py-0.5 text-[0.85em]',
				isOwn ? 'bg-primary-foreground/15' : 'bg-muted'
			)}>{node.text}</code
		>
	{:else if node.type === 'strong'}
		<strong class="font-semibold"><Self nodes={node.children} {messageId} {isOwn} /></strong>
	{:else if node.type === 'em'}
		<em><Self nodes={node.children} {messageId} {isOwn} /></em>
	{:else if node.type === 'del'}
		<del class="opacity-80"><Self nodes={node.children} {messageId} {isOwn} /></del>
	{:else if node.type === 'link'}
		<button
			type="button"
			onclick={() => void openMessageLink(node.href)}
			class={cn(
				'max-w-full min-w-0 whitespace-normal',
				MESSAGE_LINK_WRAP_CLASS,
				isOwn
					? 'text-primary-foreground hover:text-primary-foreground/80'
					: 'text-foreground hover:text-foreground/80'
			)}
		>
			{node.text}
		</button>
	{:else if node.type === 'softbreak'}
		<br />
	{/if}
{/each}
