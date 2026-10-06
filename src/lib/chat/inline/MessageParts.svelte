<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import InlineMediaUrl from '$lib/components/chat/InlineMediaUrl.svelte';
	import NostrEventEmbed from '$lib/components/chat/NostrEventEmbed.svelte';
	import { cn, mediaUrlKind } from '$lib/utils';
	import { getCachedChatMessageParts } from '$lib/components/chat/chatMessageRenderCache';
	import type { ChatMentionTextPart } from '$lib/services/chatMentions';
	import { openMessageLink } from '$lib/utils/groupShareLink';
	import {
		MESSAGE_LINK_WRAP_CLASS,
		MESSAGE_PART_CONTAINER_CLASS
	} from '$lib/chat/messageTextClasses';

	/**
	 * Renders parsed message parts (mentions, links, inline media, text) as an
	 * inline fragment — no wrapping element. Shared by the chat bubble (TextInline)
	 * and the message-info sidebar (DefaultRich) so link + media rendering can't
	 * drift between them. Callers wrap this in their own <p>.
	 *
	 * `parts` overrides the cached parse: the bubble passes the invite-stripped
	 * body parts (its cards stand in for the removed links); the sidebar omits it
	 * and keeps the verbatim text.
	 */
	let {
		messageId,
		text,
		isOwn = false,
		parts: partsProp
	}: { messageId: string; text: string; isOwn?: boolean; parts?: ChatMentionTextPart[] } = $props();

	const parts = $derived(partsProp ?? getCachedChatMessageParts(messageId, text));
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
	{:else if part.type === 'event'}
		<!-- Block span inside the bubble <p>: a div here would be invalid nesting. -->
		<NostrEventEmbed pointer={part.pointer} text={part.text} {isOwn} />
	{:else if part.type === 'link' && mediaUrlKind(part.href)}
		<InlineMediaUrl href={part.href} {isOwn} />
	{:else if part.type === 'link'}
		<button
			type="button"
			onclick={() => void openMessageLink(part.href)}
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
