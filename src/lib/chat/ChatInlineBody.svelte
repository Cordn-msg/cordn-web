<script lang="ts">
	import { inlineBodies, defaultInlineBody, type InlineBodyProps } from '$lib/chat/registry';
	import { isCalendarEventKind } from '$lib/chat/calendar';
	import CollapsibleText from '$lib/components/chat/CollapsibleText.svelte';

	let { message, groupId, onVote, onOpenRich }: InlineBodyProps = $props();

	const Body = $derived(inlineBodies[message.kind] ?? defaultInlineBody);
</script>

<!-- Deleted rows never mount this (gated in ChatMessageItem); empty text is a
     no-op clamp. Calendar bodies own their clamp: message.text is the event
     description, so the generic wrapper would clamp the whole card. -->
{#if isCalendarEventKind(message.kind)}
	<Body {message} {groupId} {onVote} {onOpenRich} />
{:else}
	<CollapsibleText length={message.text.length} isOwn={message.isOwn ?? false}>
		<Body {message} {groupId} {onVote} {onOpenRich} />
	</CollapsibleText>
{/if}
