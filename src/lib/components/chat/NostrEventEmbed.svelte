<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import ChatMarkdown from '$lib/chat/markdown/ChatMarkdown.svelte';
	import CollapsibleText from '$lib/components/chat/CollapsibleText.svelte';
	import { getCachedChatMarkdownBlocks } from '$lib/components/chat/chatMessageRenderCache';
	import { useNostrEvent } from '$lib/services/useNostrEvent.svelte';
	import { getRenderNostrEmbeds } from '$lib/services/chatComposerSettings.svelte';
	import { openMessageLink } from '$lib/utils/groupShareLink';
	import { formatUnixTimestamp, copyToClipboard, cn } from '$lib/utils';
	import { MESSAGE_PART_CONTAINER_CLASS } from '$lib/chat/messageTextClasses';
	import {
		DropdownMenuRoot,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger
	} from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import { kinds } from 'nostr-tools';
	import type { AddressPointer, EventPointer } from 'nostr-tools/nip19';

	/**
	 * Inline card for a pasted nostr event pointer (nevent/naddr/note),
	 * rendered where the bech32 string sat in the message. Loads the event via
	 * the shared event store + loaders (dedup + relay hints), renders its
	 * content through the SAME pipeline as cordn messages (markdown cache →
	 * mention/link parts), so links/media inside remote notes work unchanged.
	 * Content kinds beyond text notes and long-form show a label-only card —
	 * their content is lists/metadata JSON, not prose. The ⋯ menu copies the
	 * entity or opens it on nostr.at.
	 */
	let {
		pointer,
		text,
		isOwn = false
	}: { pointer: EventPointer | AddressPointer; text: string; isOwn?: boolean } = $props();

	const NOT_FOUND_TIMEOUT_MS = 10_000;
	// Reads reactive module state: toggling the setting re-binds (or unbinds)
	// the subscription and re-arms the timeout without a remount.
	const renderEmbeds = $derived(getRenderNostrEmbeds());
	const event = useNostrEvent(() => (renderEmbeds ? pointer : undefined));

	let timedOut = $state(false);
	$effect(() => {
		if (!renderEmbeds) return;
		timedOut = false;
		const timer = setTimeout(() => (timedOut = true), NOT_FOUND_TIMEOUT_MS);
		return () => clearTimeout(timer);
	});

	// nostr: URI → OS handoff. The native WebView fires an ACTION_VIEW intent
	// for non-http schemes (installed Nostr apps catch it); browsers offer the
	// registered protocol handler. No handler → silent no-op; the web viewers
	// in the menu are the fallback.
	function openInApp() {
		window.location.href = `nostr:${entity}`;
	}

	// Short labels: on phone-width bubbles the label competes with the author
	// chip in one row — "Long-form article" starved the chip to per-character
	// wrap even after truncation landed.
	const KIND_LABELS: Record<number, string> = {
		[kinds.ShortTextNote]: 'Note',
		[kinds.LongFormArticle]: 'Article',
		[kinds.Metadata]: 'Metadata',
		[kinds.Contacts]: 'Contacts',
		[kinds.RelayList]: 'Relays'
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
	// Kind/time meta + the ⋯ trigger sit on the card surface: muted-foreground
	// is unreadable on own bubbles (bg-primary), so the meta color follows the
	// bubble side like every other secondary text in a row.
	const metaClass = $derived(isOwn ? 'text-primary-foreground/70' : 'text-muted-foreground');
	// Author chip mirrors the @mention chip styling, with an explicit text
	// color: ProfileCard inline inherits text-current, and the header row's
	// muted-foreground on an own bubble (bg-primary) is unreadable.
	const authorChipClass = $derived(
		cn(
			'inline-flex max-w-full min-w-0 rounded-full px-1 font-semibold',
			MESSAGE_PART_CONTAINER_CLASS,
			isOwn ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-muted text-foreground'
		)
	);
	// The bech32 without any nostr: prefix — the canonical form to copy/link.
	const entity = $derived(text.replace(/^nostr:/, ''));
	const externalHref = $derived(`https://nostr.at/${entity}`);
	// NIP-23 long-form carries title/summary in tags, not content — without
	// the title an article reads as a wall of header-less text.
	const articleTitle = $derived(
		event.current?.kind === kinds.LongFormArticle
			? (event.current.tags.find((tag) => tag[0] === 'title')?.[1] ?? '')
			: ''
	);
	const markdownBlocks = $derived(
		event.current && CONTENT_KINDS.has(event.current.kind)
			? getCachedChatMarkdownBlocks(event.current.id, event.current.content)
			: null
	);
</script>

{#snippet overflowMenu()}
	<DropdownMenuRoot>
		<DropdownMenuTrigger>
			{#snippet child({ props })}
				<Button
					{...props}
					type="button"
					variant="ghost"
					size="icon-sm"
					class={cn('size-6 shrink-0 rounded-lg', metaClass)}
					aria-label="Event actions"
					onclick={(e) => e.stopPropagation()}
				>
					<Ellipsis class="size-4" />
				</Button>
			{/snippet}
		</DropdownMenuTrigger>
		<DropdownMenuContent side="bottom" align="end" sideOffset={4} class="rounded-2xl p-1">
			<DropdownMenuItem onclick={openInApp}>Open in app</DropdownMenuItem>
			<DropdownMenuItem onclick={() => void copyToClipboard(entity)}>Copy entity</DropdownMenuItem>
			<DropdownMenuItem onclick={() => void openMessageLink(externalHref)}>
				Open in nostr.at
			</DropdownMenuItem>
			<DropdownMenuItem onclick={() => void openMessageLink(`https://njump.me/${entity}`)}>
				Open in njump.me
			</DropdownMenuItem>
			<DropdownMenuItem
				onclick={() => void openMessageLink(`https://jumble.social/notes/${entity}`)}
			>
				Open in Jumble
			</DropdownMenuItem>
		</DropdownMenuContent>
	</DropdownMenuRoot>
{/snippet}

{#if !renderEmbeds}
	<!-- Setting off: plain reference, no card, no relay fetch. The ⋯ menu
	     stays so the event can still be opened/copied externally. -->
	<span class="inline-flex max-w-full min-w-0 items-baseline gap-0.5 align-baseline">
		<span class={cn('min-w-0 truncate font-mono text-xs', metaClass)} title={entity}>{entity}</span>
		{@render overflowMenu()}
	</span>
{:else if event.current}
	<span class={cardClass}>
		<span class={cn('flex min-w-0 items-center gap-2 text-xs', metaClass)}>
			<span class={authorChipClass}>
				<ProfileCard
					pubkey={event.current.pubkey}
					mode="inline"
					showInlineAvatar={true}
					profileLink={false}
				/>
			</span>
			<span class="shrink-0">{kindLabel(event.current.kind)}</span>
			<span class="shrink-0">{formatUnixTimestamp(event.current.created_at, true, false)}</span>
			<span class="ml-auto flex shrink-0 items-center">
				{@render overflowMenu()}
			</span>
		</span>
		{#if articleTitle}
			<span class="mt-1 block text-sm font-semibold">{articleTitle}</span>
		{/if}
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
				aria-label="Open on nostr.at"
			>
				Open externally
			</button>
		</span>
	</span>
{:else}
	<!-- Fixed min width: the bubble sizes to its content, so without one the
	     skeleton collapses to a sliver until the event resolves. -->
	<span
		class={cn(cardClass, 'w-60 max-w-full animate-pulse space-y-1.5')}
		aria-label="Loading nostr event"
	>
		<span class="block h-3 w-1/3 rounded-full bg-muted"></span>
		<span class="block h-3 w-3/4 rounded-full bg-muted"></span>
		<span class="block h-3 w-1/2 rounded-full bg-muted"></span>
	</span>
{/if}
