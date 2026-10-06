<script lang="ts">
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import ChatInviteCard from '$lib/components/chat/ChatInviteCard.svelte';
	import ChatMarkdown from '$lib/chat/markdown/ChatMarkdown.svelte';
	import {
		getCachedChatMarkdownBlocks,
		getCachedChatMessageInvites
	} from '$lib/components/chat/chatMessageRenderCache';
	import { cn } from '$lib/utils';
	import type { ChatMessage } from '$lib/components/chat/chat.types';
	import { MESSAGE_TEXT_WRAP_CLASS } from '$lib/chat/messageTextClasses';

	let { message }: { message: ChatMessage } = $props();

	const isOwn = $derived(message.isOwn ?? false);
	// Markdown fast lane: plain texts (the overwhelming majority) render through
	// the unchanged mention/link pipeline; markdown texts render from a cached
	// block VM. Null = no markdown.
	const markdownBlocks = $derived(getCachedChatMarkdownBlocks(message.id, message.text));
	// Invite cards ride the plain-text pipeline only: a markdown-formatted link
	// stays a styled link (still routed by openMessageLink).
	const invites = $derived(getCachedChatMessageInvites(message.id, message.text));
	const hasBody = $derived(
		invites.bodyParts.some((part) => part.type !== 'text' || part.text.trim() !== '')
	);
</script>

{#if markdownBlocks}
	<ChatMarkdown blocks={markdownBlocks} messageId={message.id} {isOwn} />
{:else}
	{#if hasBody}
		<p class={cn('max-w-full min-w-0', MESSAGE_TEXT_WRAP_CLASS)}>
			<MessageParts messageId={message.id} text={message.text} parts={invites.bodyParts} {isOwn} />
		</p>
	{/if}
	{#each invites.invites as invite, index (`${message.id}:invite:${index}`)}
		<ChatInviteCard {invite} {isOwn} />
	{/each}
{/if}
