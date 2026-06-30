<script lang="ts">
	import { inlineBodies, defaultInlineBody, type InlineBodyProps } from '$lib/chat/registry';

	let { message, onOpenRich }: InlineBodyProps = $props();

	const Body = $derived(inlineBodies[message.kind] ?? defaultInlineBody);
</script>

<Body {message} {onOpenRich} />
