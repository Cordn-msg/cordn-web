<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import ChatMarkdown from '$lib/chat/markdown/ChatMarkdown.svelte';
	import CollapsibleText from '$lib/components/chat/CollapsibleText.svelte';
	import { getCachedChatMarkdownBlocks } from '$lib/components/chat/chatMessageRenderCache';
	import { useNostrEvent } from '$lib/services/useNostrEvent.svelte';
	import { openMessageLink } from '$lib/utils/groupShareLink';
	import { formatUnixTimestamp, cn } from '$lib/utils';
	import { kinds } from 'nostr-tools';
	import type { AddressPointer, EventPointer } from 'nostr-tools/nip19';

	/**
	 * Inline card for a pasted nostr event pointer (nevent/naddr/note),
	 * rendered where the bech32 string sat in the message. Loads the event via
	 * the shared event store + loaders (dedup + relay hints), renders its
	 * content through the SAME pipeline as cordn messages (markdown cache →
	 * mention/link parts), so links/media inside remote notes work unchanged.
	 * Content kinds beyond text notes and long-form show a label-only card —
	 * their content is lists/metadata JSON, not prose.
	 */
	let {
		pointer,
		text,
		isOwn = false
	}: { pointer: EventPointer | AddressPointer; text: string; isOwn?: boolean } = $props();

	const NOT_FOUND_TIMEOUT_MS = 10_000;
	const event = useNostrEvent(() => pointer);

	let timedOut = $state(false);
	$effect(() => {
		timedOut = false;
		const timer = setTimeout(() => (timedOut = true), NOT_FOUND_TIMEOUT_MS);
		return () => clearTimeout(timer);
	});

	const KIND_LABELS: Record<number, string> = {
		[kinds.ShortTextNote]: 'Note',
		[kinds.LongFormArticle]: 'Long-form article',
		[kinds.Metadata]: 'Profile metadata',
		[kinds.Contacts]: 'Contact list',
		[kinds.RelayList]: 'Relay list'
	};
	const kindLabel = (kind: number) => KIND_LABELS[kind] ?? `Kind ${kind}`;
	/** Prose kinds render content; everything else is a label-only card. */
	const CONTENT_KINDS = new Set([kinds.ShortTextNote, kinds.LongFormArticle]);

	const cardClass = $derived(
		cn(
			'my-1 block max-w-full min-w-0 rounded-2xl border px-3 py-2 text-left',
			isOwn ? 'border-primary-foreground/25 bg-primary-foreground/10' : 'border-border bg-muted/30'
		)
	);
	const externalHref = $derived(`https://njump.me/${text.replace(/^nostr:/, '')}`);
	const markdownBlocks = $derived(
		event.current && CONTENT_KINDS.has(event.current.kind)
			? getCachedChatMarkdownBlocks(event.current.id, event.current.content)
			: null
	);
</script>

{#if event.current}
	<span class={cardClass}>
		<span class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
			<span class="min-w-0 truncate font-medium text-foreground">
				<ProfileCard pubkey={event.current.pubkey} mode="inline" profileLink={false} />
			</span>
			<span class="shrink-0">{kindLabel(event.current.kind)}</span>
			<span class="shrink-0">{formatUnixTimestamp(event.current.created_at, true, false)}</span>
		</span>
		{#if CONTENT_KINDS.has(event.current.kind) && event.current.content}
			<span class="mt-1 block text-sm">
				<CollapsibleText length={event.current.content.length} {isOwn}>
					{#if markdownBlocks}
						<ChatMarkdown blocks={markdownBlocks} messageId={event.current.id} {isOwn} />
					{:else}
						<MessageParts messageId={event.current.id} text={event.current.content} {isOwn} />
					{/if}
				</CollapsibleText>
			</span>
		{/if}
	</span>
{:else if timedOut}
	<span class={cardClass}>
		<span class="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
			<span class="min-w-0 truncate"
				>{'id' in pointer ? 'Event' : kindLabel(pointer.kind)} not found on relays</span
			>
			<button
				type="button"
				class="shrink-0 font-medium underline-offset-2 hover:underline"
				onclick={() => void openMessageLink(externalHref)}
				aria-label="Open on njump"
			>
				Open externally
			</button>
		</span>
	</span>
{:else}
	<span class={cn(cardClass, 'animate-pulse space-y-1.5')} aria-label="Loading nostr event">
		<span class="block h-3 w-1/3 rounded-full bg-muted"></span>
		<span class="block h-3 w-3/4 rounded-full bg-muted"></span>
		<span class="block h-3 w-1/2 rounded-full bg-muted"></span>
	</span>
{/if}
