<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { cn } from '$lib/utils';
	import type { ChatMessage } from '$lib/components/chat/chat.types';
	import { getCachedChatMessageParts } from '$lib/components/chat/chatMessageRenderCache';
	import {
		MESSAGE_LINK_WRAP_CLASS,
		MESSAGE_PART_CONTAINER_CLASS,
		MESSAGE_TEXT_WRAP_CLASS
	} from '$lib/chat/messageTextClasses';

	let { message }: { message: ChatMessage } = $props();

	const isOwn = $derived(message.isOwn ?? false);
	const messageParts = $derived(getCachedChatMessageParts(message.id, message.text));

	function openExternalLink(href: string) {
		window.open(href, '_blank', 'noopener,noreferrer');
	}
</script>

<p class={cn('max-w-full min-w-0', MESSAGE_TEXT_WRAP_CLASS)}>
	{#each messageParts as part, index (`${message.id}:part:${index}`)}
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
		{:else if part.type === 'link'}
			<button
				type="button"
				onclick={() => openExternalLink(part.href)}
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
</p>
