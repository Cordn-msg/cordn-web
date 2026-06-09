<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import AtSign from '@lucide/svelte/icons/at-sign';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Reply from '@lucide/svelte/icons/reply';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import X from '@lucide/svelte/icons/x';
	import { Metadata } from 'nostr-tools/kinds';
	import { nip19 } from 'nostr-tools';
	import ProfileCard from '../ProfileCard.svelte';
	import type { ChatMentionCandidate, ChatMentionReference } from './chat.types';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';

	const COMPOSER_PREVIEW_WRAP_CLASS =
		'line-clamp-2 min-w-0 max-w-full text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]';
	const COMPOSER_INPUT_WRAP_CLASS =
		'field-sizing-fixed min-h-11 w-full min-w-0 max-w-full overflow-x-hidden whitespace-pre-wrap break-words rounded-xl border border-input bg-card text-sm shadow-xs [overflow-wrap:anywhere] [word-break:break-word]';

	let {
		value = $bindable(''),
		onSubmit,
		disabled = false,
		replyTo = null,
		editTo = null,
		onCancelReply = () => {},
		onCancelEdit = () => {},
		focusKey = 0,
		mentionCandidates = [],
		selectedMentions = $bindable([]),
		unreadReferenceCount = 0,
		onNavigateToReference = () => {}
	}: {
		value?: string;
		onSubmit: () => void;
		disabled?: boolean;
		replyTo?: { author: string; authorLabel?: string; text: string } | null;
		editTo?: { text: string } | null;
		onCancelReply?: () => void;
		onCancelEdit?: () => void;
		focusKey?: number;
		mentionCandidates?: ChatMentionCandidate[];
		selectedMentions?: ChatMentionReference[];
		unreadReferenceCount?: number;
		onNavigateToReference?: () => void | Promise<void>;
	} = $props();

	let textareaRef: HTMLTextAreaElement | null = $state(null);
	let expanded = $state(false);
	let mentionQuery = $state('');
	let mentionStart = $state(-1);
	let highlightedMentionIndex = $state(0);
	const profileHints = useProfileHints(() =>
		mentionCandidates.map((candidate) => candidate.pubkey)
	);

	const activeMention = $derived(mentionStart >= 0);
	const mentionMatches = $derived.by(() => {
		if (!activeMention) return [];
		const query = mentionQuery.toLowerCase();
		if (!query) return mentionCandidates.slice(0, 6);
		return mentionCandidates
			.map((candidate) => {
				const profile = profileHints[candidate.pubkey];
				const npub = nip19.npubEncode(candidate.pubkey);
				const values = [
					candidate.name || profile?.name,
					candidate.displayName || profile?.displayName,
					candidate.nip05 || profile?.nip05,
					candidate.pubkey,
					npub
				].filter((value): value is string => Boolean(value));
				const exactPrefix = values.some((value) => value.toLowerCase().startsWith(query));
				const includes = values.some((value) => value.toLowerCase().includes(query));
				return { candidate, score: exactPrefix ? 0 : includes ? 1 : 2 };
			})
			.filter((entry) => entry.score < 2)
			.sort((a, b) => a.score - b.score)
			.slice(0, 6)
			.map((entry) => entry.candidate);
	});

	function getMentionLabel(candidate: ChatMentionCandidate) {
		const profile = profileHints[candidate.pubkey];
		const npub = nip19.npubEncode(candidate.pubkey);
		return (
			candidate.name ||
			profile?.name ||
			candidate.displayName ||
			profile?.displayName ||
			candidate.nip05 ||
			profile?.nip05 ||
			`${npub.slice(0, 12)}…`
		);
	}

	function getMentionHint(candidate: ChatMentionCandidate) {
		const profile = profileHints[candidate.pubkey];
		return candidate.nip05 || profile?.nip05 || nip19.npubEncode(candidate.pubkey);
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (disabled) return;
		onSubmit();
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (disabled) return;
		if (activeMention && mentionMatches.length > 0) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				highlightedMentionIndex = (highlightedMentionIndex + 1) % mentionMatches.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				highlightedMentionIndex =
					(highlightedMentionIndex - 1 + mentionMatches.length) % mentionMatches.length;
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				selectMention(mentionMatches[highlightedMentionIndex]);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				closeMentionDialog();
				return;
			}
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			onSubmit();
		}
	}

	function handleInput(event: Event) {
		updateMentionState(event.currentTarget as HTMLTextAreaElement);
		requestAnimationFrame(() => resizeTextarea());
	}

	function updateMentionState(target: HTMLTextAreaElement) {
		const caret = target.selectionStart;
		const beforeCaret = value.slice(0, caret);
		const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret);
		if (!match) {
			closeMentionDialog();
			return;
		}
		mentionStart = beforeCaret.length - match[2].length - 1;
		mentionQuery = match[2];
		highlightedMentionIndex = 0;
	}

	function closeMentionDialog() {
		mentionStart = -1;
		mentionQuery = '';
		highlightedMentionIndex = 0;
	}

	function selectMention(candidate: ChatMentionCandidate) {
		if (!textareaRef || mentionStart < 0) return;
		const label = getMentionLabel(candidate).replace(/\s+/g, '');
		const caret = textareaRef.selectionStart;
		const beforeMention = value.slice(0, mentionStart);
		const afterMention = value.slice(caret).replace(/^\s*/, '');
		const nextValue = `${beforeMention}@${label} ${afterMention}`;
		value = nextValue;
		selectedMentions = [
			...selectedMentions.filter((mention) => mention.pubkey !== candidate.pubkey),
			{ pubkey: candidate.pubkey, label }
		];
		closeMentionDialog();
		queueMicrotask(() => {
			if (!textareaRef) return;
			const nextCaret = beforeMention.length + label.length + 2;
			textareaRef.focus();
			textareaRef.setSelectionRange(nextCaret, nextCaret);
			resizeTextarea();
		});
	}

	function resizeTextarea() {
		if (!textareaRef) return;
		textareaRef.style.height = 'auto';
		textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, expanded ? 320 : 128)}px`;
		textareaRef.style.overflowY =
			textareaRef.scrollHeight > (expanded ? 320 : 128) ? 'auto' : 'hidden';
	}

	$effect(() => {
		void focusKey;
		if (!textareaRef || disabled) return;
		textareaRef.focus();
		const length = textareaRef.value.length;
		textareaRef.setSelectionRange(length, length);
		resizeTextarea();
	});

	$effect(() => {
		void value;
		if (!textareaRef) return;
		requestAnimationFrame(() => resizeTextarea());
	});

	$effect(() => {
		if (!replyTo) return;
		const sub = addressLoader({
			kind: Metadata,
			pubkey: replyTo.author,
			relays: metadataRelays
		}).subscribe();

		return () => sub.unsubscribe();
	});

	$effect(() => {
		void expanded;
		resizeTextarea();
	});
</script>

<div class="border-t border-border bg-background">
	<form class="mx-auto max-w-5xl px-3 py-3 sm:px-4 md:px-6" onsubmit={handleSubmit}>
		{#if editTo}
			<div
				class="mb-3 flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2"
			>
				<div class="min-w-0">
					<div class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
						<Pencil class="size-3.5" />
						<span>Editing message</span>
					</div>
					<p class={`${COMPOSER_PREVIEW_WRAP_CLASS} text-foreground/80`}>
						{editTo.text}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="h-8 w-8 shrink-0 rounded-lg"
					onclick={onCancelEdit}
					aria-label="Cancel edit"
				>
					<X class="size-4" />
				</Button>
			</div>
		{/if}

		{#if replyTo}
			<div
				class="mb-3 flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2"
			>
				<div class="min-w-0">
					<div class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
						<Reply class="size-3.5" />
						<span>Replying to</span>
						<ProfileCard
							pubkey={replyTo.author}
							mode="inline"
							showInlineAvatar={true}
							profileLink={false}
						/>
					</div>
					<p class={`${COMPOSER_PREVIEW_WRAP_CLASS} text-foreground/80`}>
						{replyTo.text}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="h-8 w-8 shrink-0 rounded-lg"
					onclick={onCancelReply}
					aria-label="Cancel reply"
				>
					<X class="size-4" />
				</Button>
			</div>
		{/if}

		<div class="flex min-w-0 items-end gap-3">
			<div class="flex min-w-0 flex-1 flex-col gap-2">
				{#if unreadReferenceCount > 0}
					<div class="flex justify-center">
						<Button
							type="button"
							variant="secondary"
							size="sm"
							class="h-8 gap-2 rounded-full shadow-lg"
							onclick={onNavigateToReference}
							aria-label="Jump to unread reference"
						>
							<AtSign class="size-4" />
							<span>{unreadReferenceCount}</span>
						</Button>
					</div>
				{/if}
				{#if activeMention && mentionMatches.length > 0}
					<div class="rounded-xl border border-border bg-popover p-1 shadow-lg">
						{#each mentionMatches as candidate, index (candidate.pubkey)}
							<button
								type="button"
								class={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${index === highlightedMentionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`}
								onclick={() => selectMention(candidate)}
							>
								<div class="min-w-0 flex-1">
									<ProfileCard pubkey={candidate.pubkey} mode="compact" profileLink={false} />
									<p class="mt-1 truncate text-xs text-muted-foreground">
										{getMentionHint(candidate)}
									</p>
								</div>
							</button>
						{/each}
					</div>
				{/if}
				<div class="flex justify-center">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-8 w-8 rounded-lg"
						onclick={() => (expanded = !expanded)}
						aria-label={expanded ? 'Collapse composer' : 'Expand composer'}
					>
						<ChevronUp class={`size-4 transition-transform ${!expanded ? '' : 'rotate-180'}`} />
					</Button>
				</div>
				<Textarea
					bind:ref={textareaRef}
					bind:value
					placeholder="Type a message..."
					rows={expanded ? 6 : 1}
					wrap="soft"
					{disabled}
					onkeydown={handleKeyDown}
					oninput={handleInput}
					class={COMPOSER_INPUT_WRAP_CLASS}
					style={`max-height: ${expanded ? 320 : 128}px; min-height: ${expanded ? 144 : 44}px;`}
				/>
			</div>
			<Button
				type="submit"
				class="h-11 shrink-0 rounded-xl px-4"
				disabled={disabled || !value.trim()}
			>
				<SendHorizontal class="size-4" />
			</Button>
		</div>
	</form>
</div>
