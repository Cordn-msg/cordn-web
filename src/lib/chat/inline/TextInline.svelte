<script lang="ts">
	import MessageParts from './MessageParts.svelte';
	import { cn } from '$lib/utils';
	import type { ChatMessage } from '$lib/components/chat/chat.types';
	import { MESSAGE_TEXT_WRAP_CLASS } from '$lib/chat/messageTextClasses';

	let { message }: { message: ChatMessage } = $props();

	const isOwn = $derived(message.isOwn ?? false);
</script>

<p class={cn('max-w-full min-w-0', MESSAGE_TEXT_WRAP_CLASS)}>
	<MessageParts messageId={message.id} text={message.text} {isOwn} />
</p>
