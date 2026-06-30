<script lang="ts">
	import { richBodies, defaultRichBody, type RichBodyProps } from '$lib/chat/registry';
	import { listChatGroupMessages } from '$lib/services/chatGroups.svelte';

	let { groupId, eventId, onNavigate, onJumpToMessage }: RichBodyProps = $props();

	const subject = $derived(
		listChatGroupMessages(groupId).find((message) => message.id === eventId)
	);
	const Body = $derived(subject ? (richBodies[subject.kind] ?? defaultRichBody) : null);
</script>

{#if Body && subject}
	<Body {groupId} {eventId} {onNavigate} {onJumpToMessage} />
{:else}
	<div class="p-6 text-sm text-muted-foreground">This message is no longer available.</div>
{/if}
