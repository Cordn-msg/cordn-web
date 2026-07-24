<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import InlineMediaUrl from '$lib/components/chat/InlineMediaUrl.svelte';
	import { cn, mediaUrlKind } from '$lib/utils';
	import { getCachedChatMessageParts } from '$lib/components/chat/chatMessageRenderCache';
	import { openExternal } from '$lib/services/nativeShims';
	import {
		MESSAGE_LINK_WRAP_CLASS,
		MESSAGE_PART_CONTAINER_CLASS
	} from '$lib/chat/messageTextClasses';

	/**
	 * Renders parsed message parts (mentions, links, inline media, text) as an
	 * inline fragment — no wrapping element. Shared by the chat bubble (TextInline)
	 * and the message-info sidebar (DefaultRich) so link + media rendering can't
	 * drift between them. Callers wrap this in their own <p>.
	 */
	let {
		messageId,
		text,
		isOwn = false
	}: { messageId: string; text: string; isOwn?: boolean } = $props();

	const parts = $derived(getCachedChatMessageParts(messageId, text));
</script>

{#each parts as part, index (`${messageId}:part:${index}`)}
	{#if part.type === 'profile'}
		<span
			class={cn(
				'inline-flex max-w-full min-w-0 rounded-full px-1 font-semibold',
				MESSAGE_PART_CONTAINER_CLASS,
				isOwn ? 'bg-primary-foreground/15' : 'bg-muted text-foreground'
			)}
		>
			@<ProfileCard pubkey={part.pubkey} mode="inline" profileLink={false} />
		</span>
	{:else if part.type === 'link' && mediaUrlKind(part.href)}
		<InlineMediaUrl href={part.href} {isOwn} />
	{:else if part.type === 'link'}
		<button
			type="button"
			onclick={() => void openExternal(part.href)}
			class={cn(
				'max-w-full min-w-0 whitespace-normal',
				MESSAGE_LINK_WRAP_CLASS,
				isOwn
					? 'text-primary-foreground hover:text-primary-foreground/80'
					: 'text-foreground hover:text-foreground/80'
			)}
		>
			{part.text}
		</button>
	{:else}
		<span class={MESSAGE_PART_CONTAINER_CLASS}>{part.text}</span>
	{/if}
{/each}
