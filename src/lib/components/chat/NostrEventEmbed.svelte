<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import ChatMarkdown from '$lib/chat/markdown/ChatMarkdown.svelte';
	import CollapsibleText from '$lib/components/chat/CollapsibleText.svelte';
	import GitPullRequestEmbed from '$lib/components/chat/GitPullRequestEmbed.svelte';
	import { getCachedChatMarkdownBlocks } from '$lib/components/chat/chatMessageRenderCache';
	import { useNostrEvent } from '$lib/services/useNostrEvent.svelte';
	import { getRenderNostrEmbeds } from '$lib/services/chatComposerSettings.svelte';
	import {
		getHighlightContext,
		getHighlightSources,
		splitHighlightContext,
		type ChatHighlightNostrSource
	} from '$lib/chat/highlights';
	import { parseGitPullRequest } from '$lib/chat/gitPullRequests';
	import { openMessageLink } from '$lib/utils/groupShareLink';
	import { formatUnixTimestamp, copyToClipboard, cn } from '$lib/utils';
	import {
		MESSAGE_PART_CONTAINER_CLASS,
		MESSAGE_TEXT_WRAP_CLASS
	} from '$lib/chat/messageTextClasses';
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
	 * the shared event store + loaders (dedup + relay hints) and renders its
	 * content through the SAME pipeline as cordn messages (markdown cache →
	 * mention/link parts) for every kind, so links/media inside remote notes
	 * work unchanged — label-only when the content is empty. NIP-84
	 * highlights render as quotes with source attribution. The ⋯ menu copies
	 * the entity or opens it on nostr.at.
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
		[kinds.RelayList]: 'Relays',
		[kinds.Highlights]: 'Highlight',
		[kinds.GitPullRequest]: 'Pull request'
	};
	const kindLabel = (kind: number) => KIND_LABELS[kind] ?? `Kind ${kind}`;

	// NIP-34 pull requests get their own body; the shared card header/meta/
	// overflow menu stays here so PR and non-PR cards cannot drift apart.
	const isPullRequest = $derived(event.current?.kind === kinds.GitPullRequest);
	const pullRequest = $derived(
		isPullRequest
			? parseGitPullRequest(event.current?.tags ?? [], event.current?.content ?? '')
			: null
	);

	// NIP-84 highlights: content is the highlighted excerpt; a comment tag
	// turns it into a quote highlight (comment = the highlighter's prose,
	// content = the quoted excerpt below it).
	const isHighlight = $derived(event.current?.kind === kinds.Highlights);
	const highlightComment = $derived(
		isHighlight ? (event.current?.tags.find((tag) => tag[0] === 'comment')?.[1] ?? '') : ''
	);
	const highlightContext = $derived(
		isHighlight ? (getHighlightContext(event.current?.tags ?? []) ?? '') : ''
	);

	// flex-col (not block): Svelte keeps single-space text nodes between the
	// card sections, and in a block container each becomes an anonymous block
	// with the bubble's inherited line height — a full phantom blank line
	// (~28px) between name/meta/content. Flex containers drop whitespace-only
	// children, so the sections stack at their margins instead.
	const cardClass = $derived(
		cn(
			'my-1 flex max-w-full min-w-0 flex-col rounded-2xl border px-3 py-2 text-left',
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
		event.current?.content
			? getCachedChatMarkdownBlocks(event.current.id, event.current.content)
			: null
	);
	// The comment is a second text of the same event — its own cache key, or
	// the id-keyed markdown cache would return the excerpt for it.
	const commentBlocks = $derived(
		highlightComment && event.current
			? getCachedChatMarkdownBlocks(`${event.current.id}:comment`, highlightComment)
			: null
	);

	const highlightSources = $derived(
		isHighlight ? getHighlightSources(event.current?.tags ?? []) : []
	);
	const highlightNostrSource = $derived(
		highlightSources.find(
			(source): source is ChatHighlightNostrSource => source.type === 'nostr' && !!source.pointer
		)
	);
	// Load the source article so its NIP-23 title can label the source row.
	const highlightSourceEvent = useNostrEvent(() =>
		renderEmbeds ? highlightNostrSource?.pointer : undefined
	);
	const highlightSourceTitle = $derived(
		highlightSourceEvent.current?.kind === kinds.LongFormArticle
			? (highlightSourceEvent.current.tags.find((tag) => tag[0] === 'title')?.[1] ?? '')
			: ''
	);
	const highlightContextParts = $derived(
		event.current && isHighlight
			? splitHighlightContext(highlightContext, event.current.content)
			: null
	);
	const highlightBodyLength = $derived(
		(event.current?.content.length ?? 0) + (highlightContext?.length ?? 0)
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
			{#if pullRequest?.cloneUrls[0]}
				<DropdownMenuItem onclick={() => void copyToClipboard(pullRequest!.cloneUrls[0])}>
					Copy clone URL
				</DropdownMenuItem>
			{/if}
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
		<!-- Two lines on purpose: the author chip owns the first row (an inline
		     kind/time label starved it to per-character wrap on phones), the
		     meta wraps below, and ⋯ stays top-right. -->
		<span class={cn('flex min-w-0 items-center gap-2', metaClass)}>
			<span class="flex min-w-0 flex-1 items-center">
				<span class={authorChipClass}>
					<ProfileCard
						pubkey={event.current.pubkey}
						mode="inline"
						showInlineAvatar={true}
						profileLink={false}
					/>
				</span>
			</span>
			{@render overflowMenu()}
		</span>
		<span class={cn('mt-0.5 block text-xs leading-4', metaClass)}>
			{kindLabel(event.current.kind)} · {formatUnixTimestamp(event.current.created_at, true, false)}
		</span>
		{#if articleTitle}
			<span class="mt-0.5 block text-sm font-semibold">{articleTitle}</span>
		{/if}
		{#if isHighlight}
			<!-- NIP-84: quote highlights lead with the comment, then the excerpt.
			     When context is available, the excerpt is emphasised inside it. -->
			{#if highlightComment}
				<span class="mt-1 block text-sm">
					<CollapsibleText length={highlightComment.length} {isOwn}>
						{#if commentBlocks}
							<ChatMarkdown
								blocks={commentBlocks}
								messageId={`${event.current.id}:comment`}
								{isOwn}
							/>
						{:else}
							<MessageParts
								messageId={`${event.current.id}:comment`}
								text={highlightComment}
								{isOwn}
							/>
						{/if}
					</CollapsibleText>
				</span>
			{/if}
			{#if highlightContextParts}
				<span
					class={cn(
						'mt-1 block border-l-2 pl-2 text-sm italic',
						isOwn ? 'border-primary-foreground/40' : 'border-border'
					)}
				>
					<CollapsibleText length={highlightBodyLength} {isOwn}>
						<span class={MESSAGE_TEXT_WRAP_CLASS}>
							{#if highlightContextParts.before}<span class={metaClass}
									>{highlightContextParts.before}</span
								>{/if}<span
								class={cn(
									'font-medium not-italic',
									isOwn ? 'text-primary-foreground' : 'text-foreground'
								)}>{highlightContextParts.highlight}</span
							>{#if highlightContextParts.after}<span class={metaClass}
									>{highlightContextParts.after}</span
								>{/if}
						</span>
					</CollapsibleText>
				</span>
			{:else if event.current.content}
				<span
					class={cn(
						'mt-1 block border-l-2 pl-2 text-sm italic',
						isOwn ? 'border-primary-foreground/40' : 'border-border'
					)}
				>
					<CollapsibleText length={event.current.content.length} {isOwn}>
						{#if markdownBlocks}
							<ChatMarkdown blocks={markdownBlocks} messageId={event.current.id} {isOwn} />
						{:else}
							<MessageParts messageId={event.current.id} text={event.current.content} {isOwn} />
						{/if}
					</CollapsibleText>
				</span>
				{#if highlightContext}
					<span class={cn('mt-1 block text-xs leading-4', metaClass)}>{highlightContext}</span>
				{/if}
			{/if}
			{#if highlightSources.length}
				<span class={cn('mt-1 flex min-w-0 flex-col gap-0.5 text-xs leading-4', metaClass)}>
					{#each highlightSources as source, index (source.type + ':' + index)}
						<span class={cn('flex min-w-0 items-center gap-1', index > 0 && 'pl-4')}>
							{#if index === 0}<span class="shrink-0">Source:</span>{/if}
							{#if source.type === 'text'}
								<span class="min-w-0 truncate">{source.label}</span>
							{:else}
								<button
									type="button"
									class="min-w-0 truncate font-medium underline-offset-2 hover:underline"
									title={source.href}
									onclick={() => void openMessageLink(source.href)}
								>
									{highlightNostrSource === source && highlightSourceTitle
										? highlightSourceTitle
										: source.label}
								</button>
							{/if}
						</span>
					{/each}
				</span>
			{/if}
		{:else if isPullRequest && pullRequest}
			<GitPullRequestEmbed event={event.current} {pullRequest} {isOwn} {metaClass} />
		{:else if event.current.content}
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
