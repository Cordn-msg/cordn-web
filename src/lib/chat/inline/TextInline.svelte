<script lang="ts">
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import ChatMarkdown from '$lib/chat/markdown/ChatMarkdown.svelte';
	import { getCachedChatMarkdownBlocks } from '$lib/components/chat/chatMessageRenderCache';
	import { cn } from '$lib/utils';
	import type { ChatMessage } from '$lib/components/chat/chat.types';
	import { MESSAGE_TEXT_WRAP_CLASS } from '$lib/chat/messageTextClasses';

	let { message }: { message: ChatMessage } = $props();

	const isOwn = $derived(message.isOwn ?? false);
	// Markdown fast lane: plain texts (the overwhelming majority) render through
	// the unchanged mention/link pipeline; markdown texts render from a cached
	// block VM. Null = no markdown.
	const markdownBlocks = $derived(getCachedChatMarkdownBlocks(message.id, message.text));
</script>

{#if markdownBlocks}
	<ChatMarkdown blocks={markdownBlocks} messageId={message.id} {isOwn} />
{:else}
	<p class={cn('max-w-full min-w-0', MESSAGE_TEXT_WRAP_CLASS)}>
		<MessageParts messageId={message.id} text={message.text} {isOwn} />
	</p>
{/if}
