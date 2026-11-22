<script lang="ts">
	import '../../../routes/layout.css';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import ChatMessageList from './ChatMessageList.svelte';
	import type { ChatMessage } from './chat.types';

	/**
	 * Test-only mount for ChatMessageList with an updatable `messages` prop
	 * (component exports give the test a plain setter) and the QueryClient
	 * context the message rows expect (profile lookups).
	 */
	let {
		initialMessages,
		focusCursor,
		unreadCount = 0
	}: { initialMessages: ChatMessage[]; focusCursor: number; unreadCount?: number } = $props();

	// Deliberately captures the initial value: the test drives updates through
	// setMessages, mimicking a store write with a fresh array identity.
	// svelte-ignore state_referenced_locally
	let messages = $state(initialMessages);
	const queryClient = new QueryClient();

	export function setMessages(next: ChatMessage[]) {
		messages = next;
	}
</script>

<div style="position: fixed; top: 0; left: 0; width: 400px; height: 600px; z-index: 2147483647;">
	<QueryClientProvider client={queryClient}>
		<ChatMessageList
			{messages}
			groupId="harness-group"
			initialFocusCursor={focusCursor}
			{unreadCount}
		/>
	</QueryClientProvider>
</div>
