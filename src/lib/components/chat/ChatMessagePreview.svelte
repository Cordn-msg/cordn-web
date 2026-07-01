<script lang="ts">
	import { cn } from '$lib/utils';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { getCachedChatMessageParts } from './chatMessageRenderCache';
	import { MESSAGE_PART_CONTAINER_CLASS } from '$lib/chat/messageTextClasses';
	import type { ChatMessage } from './chat.types';

	let { message, class: className = '' }: { message: ChatMessage; class?: string } = $props();

	const parts = $derived(getCachedChatMessageParts(message.id, message.text));
</script>

<p class={cn('max-w-full min-w-0', className)}>
	{#each parts as part, index (`${message.id}:preview:${index}`)}
		{#if part.type === 'profile'}
			<span
				class={cn('inline-flex max-w-full min-w-0 font-semibold', MESSAGE_PART_CONTAINER_CLASS)}
			>
				@<ProfileCard
					pubkey={part.pubkey}
					mode="inline"
					showInlineAvatar={false}
					profileLink={false}
				/>
			</span>
		{:else}
			<span class={MESSAGE_PART_CONTAINER_CLASS}>{part.text}</span>
		{/if}
	{/each}
</p>
