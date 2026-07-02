<script lang="ts">
	import * as Collapsible from '$lib/components/ui/collapsible';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Pencil from '@lucide/svelte/icons/pencil';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import { manager } from '$lib/services/accountManager.svelte';
	import { listChatGroupMessages } from '$lib/services/chatGroups.svelte';
	import ChatMessageMedia from '$lib/components/chat/ChatMessageMedia.svelte';
	import { peekMessageMedia } from '$lib/services/chatMediaStorage.svelte';
	import { buildAnnotationIndex, getMessageThreadReference } from '$lib/chat/references';
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import { formatUnixTimestamp, normalizePubKey } from '$lib/utils';
	import type { RichBodyProps } from '$lib/chat/registry';
	import type { StoredChatMessage } from '$lib/services/chatGroupMessages.svelte';

	let { groupId, eventId, onNavigate, onJumpToMessage }: RichBodyProps = $props();

	const MAX_THREAD_DEPTH = 4;

	const messages = $derived(listChatGroupMessages(groupId));
	const subject = $derived(messages.find((message) => message.id === eventId));
	const index = $derived(buildAnnotationIndex(messages));
	const activePubkey = $derived.by(() => {
		const pubkey = manager.getActive()?.pubkey;
		return pubkey ? normalizePubKey(pubkey) : '';
	});

	type ReactionView = {
		emoji: string;
		count: number;
		reactedByMe: boolean;
		reactors: string[];
	};

	function reactionsFor(messageId: string): ReactionView[] {
		const byEmoji = index.reactionMap.get(messageId);
		if (!byEmoji) return [];
		return Array.from(byEmoji.values()).map((entry) => ({
			emoji: entry.emoji,
			count: entry.authors.size,
			reactedByMe: activePubkey ? entry.authors.has(activePubkey) : false,
			reactors: Array.from(entry.authors)
		}));
	}

	/** Edited content if present, else original. Empty when deleted. */
	function displayText(message: StoredChatMessage): string {
		if (index.deletedIds.has(message.id)) return '';
		return index.editMap.get(message.id)?.content ?? message.content ?? '';
	}

	function isEdited(message: StoredChatMessage): boolean {
		return !index.deletedIds.has(message.id) && index.editMap.has(message.id);
	}

	const reactions = $derived(subject ? reactionsFor(subject.id) : []);
	const reactionTotal = $derived(reactions.reduce((total, reaction) => total + reaction.count, 0));
	const isDeleted = $derived(subject ? index.deletedIds.has(subject.id) : false);
	const edit = $derived(subject ? index.editMap.get(subject.id) : undefined);
	const displayContent = $derived(subject ? displayText(subject) : '');
	const isOwn = $derived(subject ? normalizePubKey(subject.sender) === activePubkey : false);
	const hasMedia = $derived(subject ? Boolean(peekMessageMedia(subject.tags ?? [])) : false);

	// Thread context — resolved purely from local message tags via the shared
	// parser. Ordered root → … → subject → descendants. Indentation is capped
	// relative to the subject: it sits at min(subjectDepth, MAX) so up to MAX
	// ancestors above AND MAX descendants below show real nesting. Deeper nodes
	// on either side clamp, instead of flattening everything once the subject
	// itself is deep.
	type ThreadNode = { msg: StoredChatMessage; displayDepth: number; isSubject: boolean };
	const threadNodes = $derived.by(() => {
		if (!subject) return [] as ThreadNode[];
		const byId = new Map(messages.map((m) => [m.id, m]));
		const parentOf = (m: StoredChatMessage): StoredChatMessage | null => {
			const ref = getMessageThreadReference(m.tags);
			return ref ? (byId.get(ref.parentId) ?? null) : null;
		};

		// ancestor chain root…subject
		const chain: StoredChatMessage[] = [];
		const seen = new Set<string>();
		for (
			let cur: StoredChatMessage | null = subject;
			cur && !seen.has(cur.id);
			cur = parentOf(cur)
		) {
			seen.add(cur.id);
			chain.unshift(cur);
		}

		const subjectDepth = chain.length - 1;
		const subjectColumn = Math.min(subjectDepth, MAX_THREAD_DEPTH);
		const columnFor = (absDepth: number) => {
			const rel = absDepth - subjectDepth;
			if (rel >= 0) return subjectColumn + Math.min(rel, MAX_THREAD_DEPTH);
			return Math.max(subjectColumn + rel, 0);
		};

		const nodes: ThreadNode[] = chain.map((msg, i) => ({
			msg,
			displayDepth: columnFor(i),
			isSubject: msg.id === subject.id
		}));

		// descendants of subject (depth-first)
		const walk = (parentId: string, depth: number, visited: Set<string>) => {
			for (const m of messages) {
				if (visited.has(m.id)) continue;
				const ref = getMessageThreadReference(m.tags);
				if (ref?.parentId !== parentId) continue;
				visited.add(m.id);
				nodes.push({ msg: m, displayDepth: columnFor(depth), isSubject: false });
				walk(m.id, depth + 1, visited);
			}
		};
		walk(subject.id, subjectDepth + 1, new Set(chain.map((m) => m.id)));
		return nodes;
	});
	const hasThread = $derived(threadNodes.some((node) => !node.isSubject));

	let reactionsOpen = $state(false);
	let advancedOpen = $state(false);
	let rawEnvelopeOpen = $state(false);
	function timeLabel(message: StoredChatMessage) {
		return formatUnixTimestamp(message.createdAt, true, false);
	}

	function fullTimestamp(message: StoredChatMessage) {
		return formatUnixTimestamp(message.createdAt, true, true);
	}
</script>

{#snippet messageMeta(message: StoredChatMessage, showEdited = false)}
	<div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
		<span class="min-w-0">
			<ProfileCard
				pubkey={message.sender}
				mode="inline"
				showInlineAvatar={true}
				profileLink={false}
			/>
		</span>
		<span class="shrink-0">{timeLabel(message)}</span>
		{#if showEdited && isEdited(message)}
			<span
				class="inline-flex shrink-0 items-center text-muted-foreground"
				aria-label="Edited"
				title="Edited"
			>
				<Pencil class="size-3" />
			</span>
		{/if}
	</div>
{/snippet}

{#snippet simpleReactions(messageId: string)}
	{@const rs = reactionsFor(messageId)}
	{#if rs.length}
		<div class="mt-1.5 flex flex-wrap gap-1.5">
			{#each rs as reaction (`${messageId}:rxn:${reaction.emoji}`)}
				<span
					class={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${reaction.reactedByMe ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border bg-muted/40 text-muted-foreground'}`}
				>
					<span>{reaction.emoji}</span>
					<span>{reaction.count}</span>
				</span>
			{/each}
		</div>
	{/if}
{/snippet}

{#if subject}
	<div class="flex min-h-full flex-col gap-5 p-3 text-sm md:p-4">
		{#if hasThread}
			<section class="space-y-1">
				<h3 class="px-1 text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
					Thread
				</h3>
				{#each threadNodes as node (node.msg.id)}
					<div class="flex items-stretch">
						{#each Array(node.displayDepth) as _, i (`${node.msg.id}:g:${i}`)}
							<span class="ml-1 w-4 shrink-0 self-stretch border-l-2 border-border/60"></span>
						{/each}
						{#if node.isSubject}
							<div class="min-w-0 flex-1 rounded-xl bg-primary/5 p-2.5 ring-1 ring-primary/20">
								<div class="flex items-start justify-between gap-2">
									{@render messageMeta(node.msg, true)}
									{#if onJumpToMessage}
										<button
											type="button"
											class="inline-flex shrink-0 items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
											title="Show in chat"
											aria-label="Show this message in chat"
											onclick={() => onJumpToMessage(eventId)}
										>
											<MessagesSquare class="size-3.5" />
										</button>
									{/if}
								</div>
								{#if isDeleted}
									<p class="mt-1 text-muted-foreground italic">This message was deleted.</p>
								{:else}
									<p class="mt-1 [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
										{displayContent}
									</p>
								{/if}
							</div>
						{:else}
							<button
								type="button"
								class="min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
								onclick={() => onNavigate?.(node.msg.id)}
							>
								{@render messageMeta(node.msg, true)}
								{#if index.deletedIds.has(node.msg.id)}
									<p class="mt-1 text-muted-foreground italic">This message was deleted.</p>
								{:else}
									<p
										class="mt-1 line-clamp-2 [overflow-wrap:anywhere] break-words whitespace-pre-wrap text-muted-foreground"
									>
										{displayText(node.msg)}
									</p>
								{/if}
								{@render simpleReactions(node.msg.id)}
							</button>
						{/if}
					</div>
				{/each}
			</section>
		{:else if !isDeleted && (displayContent || hasMedia)}
			<div class="rounded-2xl border p-4">
				{@render messageMeta(subject, true)}
				{#if hasMedia}
					<div class="mt-2">
						<ChatMessageMedia message={subject} />
					</div>
				{/if}
				{#if displayContent}
					<p class="mt-2 [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
						<MessageParts messageId={subject.id} text={displayContent} {isOwn} />
					</p>
				{/if}
			</div>
		{:else if isDeleted}
			<div class="rounded-2xl border border-dashed p-4 text-muted-foreground italic">
				This message was deleted.
			</div>
		{/if}

		{#if reactions.length}
			<section class="space-y-2">
				<Collapsible.Root bind:open={reactionsOpen}>
					<Collapsible.Trigger
						class="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-1 text-left"
					>
						<span class="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
							Reactions · {reactionTotal}
						</span>
						<ChevronRight
							class={`size-4 shrink-0 text-muted-foreground transition-transform ${reactionsOpen ? 'rotate-90' : ''}`}
						/>
					</Collapsible.Trigger>

					<div class="flex flex-wrap gap-2 px-1 pt-1">
						{#each reactions as reaction (`${subject.id}:rxn:${reaction.emoji}`)}
							<span
								class={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${reaction.reactedByMe ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border bg-muted/40 text-muted-foreground'}`}
							>
								<span>{reaction.emoji}</span>
								<span>{reaction.count}</span>
							</span>
						{/each}
					</div>

					<Collapsible.Content>
						<div class="mt-2 space-y-3 px-1">
							{#each reactions as reaction (`${subject.id}:rxn-detail:${reaction.emoji}`)}
								<div class="rounded-2xl border p-3">
									<div class="mb-2 flex items-center gap-2">
										<span class="text-lg">{reaction.emoji}</span>
										<span class="font-medium">
											{reaction.count} reaction{reaction.count === 1 ? '' : 's'}
										</span>
									</div>
									<div class="flex flex-col gap-2">
										{#each reaction.reactors as reactor (`${subject.id}:rxn-detail:${reaction.emoji}:${reactor}`)}
											<ProfileCard pubkey={reactor} mode="inline" showInlineAvatar={true} />
										{/each}
									</div>
								</div>
							{/each}
						</div>
					</Collapsible.Content>
				</Collapsible.Root>
			</section>
		{/if}

		<Collapsible.Root bind:open={advancedOpen} class="mt-auto">
			<Collapsible.Trigger
				class="flex w-full min-w-0 items-center gap-3 rounded-2xl border px-4 py-3 text-left font-medium"
			>
				<span class="min-w-0 flex-1">Advanced</span>
				<ChevronDown
					class="size-4 shrink-0 transition-transform {advancedOpen ? 'rotate-180' : ''}"
				/>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<div class="mt-3 space-y-3">
					<div class="grid gap-3 rounded-2xl border bg-muted/30 p-4 sm:grid-cols-2">
						<div class="space-y-1">
							<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
								Author
							</p>
							<ProfileCard pubkey={subject.sender} mode="inline" showInlineAvatar={true} />
						</div>
						<div class="space-y-1">
							<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Time</p>
							<p>{fullTimestamp(subject)}</p>
						</div>
						<div class="space-y-1">
							<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
								Status
							</p>
							<p>{isDeleted ? 'Deleted' : edit ? 'Edited' : 'Original'}</p>
						</div>
						<div class="space-y-1">
							<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
								Delivery
							</p>
							<p>{isOwn ? 'Sent' : 'Received'}</p>
						</div>
						<div class="space-y-1">
							<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
								Encryption
							</p>
							<p>{subject.encrypted ? 'Sealed (spec/03)' : 'Plaintext'}</p>
						</div>
					</div>

					<Collapsible.Root bind:open={rawEnvelopeOpen}>
						<Collapsible.Trigger
							class="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-2.5 text-left text-sm"
						>
							<span class="min-w-0 flex-1">Raw event envelope</span>
							<ChevronDown
								class="size-4 shrink-0 transition-transform {rawEnvelopeOpen ? 'rotate-180' : ''}"
							/>
						</Collapsible.Trigger>
						<Collapsible.Content>
							<pre
								class="mt-3 max-w-full overflow-x-auto overflow-y-auto rounded-2xl bg-muted p-4 text-xs leading-relaxed"><code
									class="block min-w-0 break-all whitespace-pre-wrap"
									>{JSON.stringify(subject, null, 2)}</code
								></pre>
						</Collapsible.Content>
					</Collapsible.Root>
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	</div>
{/if}
