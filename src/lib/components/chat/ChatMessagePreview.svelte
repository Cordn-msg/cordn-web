<script lang="ts">
	import { cn } from '$lib/utils';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import CustomEmoji from './CustomEmoji.svelte';
	import { emojiMapFromTags } from '$lib/chat/emoji';
	import { getCachedChatMessageParts } from './chatMessageRenderCache';
	import { MESSAGE_PART_CONTAINER_CLASS } from '$lib/chat/messageTextClasses';
	import type { ChatMessage } from './chat.types';

	let { message, class: className = '' }: { message: ChatMessage; class?: string } = $props();

	const emoji = $derived(emojiMapFromTags(message.displayTags ?? message.tags ?? []));
	const parts = $derived(getCachedChatMessageParts(message.id, message.text, emoji));
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
		{:else if part.type === 'emoji'}
			<CustomEmoji
				display={part.display}
				mediaKeyBase64={message.displayMediaKeyBase64 ?? message.mediaKeyBase64}
				sizeClass="size-[1.1em]"
			/>
		{:else}
			<span class={MESSAGE_PART_CONTAINER_CLASS}>{part.text}</span>
		{/if}
	{/each}
</p>
