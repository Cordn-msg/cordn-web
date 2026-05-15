<script lang="ts">
	import ChatComposer from './ChatComposer.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import ChatMessageList from './ChatMessageList.svelte';
	import type { ChatMessage } from './chat.types';
	import { manager } from '$lib/services/accountManager.svelte';
	import { formatUnixTimestamp } from '$lib/utils';
	import {
		getChatGroup,
		listChatGroupMessages,
		sendChatGroupMessage
	} from '$lib/services/chatGroups.svelte';

	let {
		groupId = 'general',
		title = 'Cordn',
		subtitle = 'Coordinator-assisted messaging'
	}: {
		groupId?: string;
		title?: string;
		subtitle?: string;
	} = $props();

	let draft = $state('');
	let sendError = $state('');
	const activePubkey = $derived.by(() => manager.getActive()?.pubkey?.trim().toLowerCase() ?? '');
	const group = $derived.by(() => getChatGroup(groupId));
	const messages = $derived.by<ChatMessage[]>(() =>
		listChatGroupMessages(groupId).map((message) => ({
			id: message.id,
			author: message.sender,
			text: message.content,
			timestamp: formatUnixTimestamp(message.createdAt, true),
			isOwn: message.sender.trim().toLowerCase() === activePubkey
		}))
	);

	async function handleSubmit() {
		const text = draft.trim();

		if (!text || !group) {
			return;
		}

		sendError = '';

		try {
			await sendChatGroupMessage({ groupId, content: text });
			draft = '';
		} catch (error) {
			sendError = error instanceof Error ? error.message : 'Failed to send message';
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<ChatHeader {groupId} {title} {subtitle} />

	<div class="min-h-0 flex-1">
		<ChatMessageList {messages} />
	</div>

	{#if sendError}
		<p class="px-4 pb-2 text-sm text-destructive md:px-6">{sendError}</p>
	{/if}

	<ChatComposer bind:value={draft} onSubmit={handleSubmit} />
</div>
