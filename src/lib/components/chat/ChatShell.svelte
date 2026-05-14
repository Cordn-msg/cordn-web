<script lang="ts">
	import ChatComposer from './ChatComposer.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import ChatMessageList from './ChatMessageList.svelte';
	import { appendGroupMessage, getGroupMessages } from './chat-data.svelte';

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
	const messages = $derived.by(() => getGroupMessages(groupId));

	function handleSubmit() {
		const text = draft.trim();

		if (!text) {
			return;
		}

		appendGroupMessage(groupId, {
			id: messages.length + 1,
			author: 'me',
			text,
			timestamp: new Date().toLocaleTimeString([], {
				hour: '2-digit',
				minute: '2-digit'
			})
		});

		draft = '';
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<ChatHeader {title} {subtitle} />

	<div class="min-h-0 flex-1">
		<ChatMessageList {messages} />
	</div>

	<ChatComposer bind:value={draft} onSubmit={handleSubmit} />
</div>
