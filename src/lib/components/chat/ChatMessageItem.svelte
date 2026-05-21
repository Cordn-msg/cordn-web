<script lang="ts">
	import { browser } from '$app/environment';
	import { Button } from '$lib/components/ui/button';
	import {
		DropdownMenuRoot,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger
	} from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import {
		Tooltip,
		TooltipContent,
		TooltipProvider,
		TooltipTrigger
	} from '$lib/components/ui/tooltip';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { eventStore } from '$lib/services/eventStore';
	import { ProfileModel } from 'applesauce-core/models';
	import Check from '@lucide/svelte/icons/check';
	import CornerUpLeft from '@lucide/svelte/icons/corner-up-left';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import SmilePlus from '@lucide/svelte/icons/smile-plus';
	import { cn, pubkeyToHexColor } from '$lib/utils';
	import type { ChatMessage } from './chat.types';

	const CUSTOM_REACTIONS_STORAGE_KEY = 'chat-custom-reactions';
	const REACTIONS = ['♥', '👍'] as const;

	let {
		message,
		showAuthor = true,
		showAvatar = true,
		showDayLabel = false,
		onReply = () => {},
		onReact = () => Promise.resolve(),
		onNavigateToMessage = () => {},
		highlighted = false
	}: {
		message: ChatMessage;
		showAuthor?: boolean;
		showAvatar?: boolean;
		showDayLabel?: boolean;
		onReply?: (message: ChatMessage) => void;
		onReact?: (message: ChatMessage, reaction: string) => void | Promise<void>;
		onNavigateToMessage?: (messageId: string) => void;
		highlighted?: boolean;
	} = $props();
	let reactionMenuOpen = $state(false);
	let customReactionOpen = $state(false);
	let customReaction = $state('');
	let customReactionInput: HTMLInputElement | null = $state(null);
	let savedReactions = $state<string[]>([]);

	const isOwn = $derived(message.isOwn ?? false);
	const actionSideClass = $derived(
		isOwn
			? 'right-0 top-0 -translate-y-[calc(100%+0.35rem)] sm:right-full sm:top-3 sm:translate-y-0 sm:mr-2'
			: 'left-0 top-0 -translate-y-[calc(100%+0.35rem)] sm:left-full sm:top-3 sm:translate-y-0 sm:ml-2'
	);
	const availableReactions = $derived.by(() => [...REACTIONS, ...savedReactions]);
	function getDeliveryStateLabel() {
		if (message.deliveryState === 'sending') return 'Sending';
		if (message.deliveryState === 'sent') return 'Sent';
		if (message.deliveryState === 'error') return 'Failed';
		return '';
	}
	const bubbleClass = $derived.by(
		() =>
			`max-w-full rounded-3xl border px-3 py-2.5 text-sm leading-6 shadow-sm transition-all sm:px-4 sm:py-3 sm:leading-7 ${
				isOwn
					? message.deliveryState === 'error'
						? 'border-destructive/40 bg-primary text-primary-foreground'
						: 'border-primary bg-primary text-primary-foreground'
					: 'border-border bg-card'
			} ${highlighted ? 'border-amber-400 bg-amber-50/70 ring-4 ring-amber-300/35 shadow-xl scale-[1.015] animate-pulse' : ''}`
	);
	const profile = $derived(eventStore.model(ProfileModel, message.author));
	const displayName = $derived.by(
		() =>
			$profile?.name ||
			$profile?.display_name ||
			$profile?.nip05 ||
			`${message.author.slice(0, 12)}…`
	);

	$effect(() => {
		if (!reactionMenuOpen || !customReactionOpen || !customReactionInput) return;
		customReactionInput.focus();
	});

	$effect(() => {
		if (!browser) return;
		try {
			const stored = localStorage.getItem(CUSTOM_REACTIONS_STORAGE_KEY);
			if (!stored) return;
			const parsed = JSON.parse(stored);
			if (!Array.isArray(parsed)) return;
			savedReactions = parsed.filter((value): value is string => typeof value === 'string');
		} catch {
			savedReactions = [];
		}
	});

	$effect(() => {
		if (!browser) return;
		localStorage.setItem(CUSTOM_REACTIONS_STORAGE_KEY, JSON.stringify(savedReactions));
	});

	function normalizeCustomReaction(value: string) {
		const trimmed = value.trim();
		if (!trimmed) return '';
		if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
			const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
			const [first] = Array.from(segmenter.segment(trimmed));
			return first?.segment ?? '';
		}
		return Array.from(trimmed)[0] ?? '';
	}

	function persistCustomReaction(reaction: string) {
		if (REACTIONS.includes(reaction as (typeof REACTIONS)[number])) return;
		if (savedReactions.includes(reaction)) return;
		savedReactions = [...savedReactions, reaction];
	}

	async function handleCustomReaction() {
		const reaction = normalizeCustomReaction(customReaction);
		if (!reaction) return;
		persistCustomReaction(reaction);
		await onReact(message, reaction);
		customReaction = '';
		customReactionOpen = false;
		reactionMenuOpen = false;
	}

	function handleReactionMenuOpenChange(open: boolean) {
		reactionMenuOpen = open;
		if (!open) {
			customReactionOpen = false;
			customReaction = '';
		}
	}
</script>

<div class="flex flex-col gap-2">
	{#if showDayLabel}
		<p class="px-2 text-center text-[11px] font-medium text-muted-foreground">{message.dayLabel}</p>
	{/if}

	<article class="flex items-end gap-2 sm:gap-3" class:flex-row-reverse={isOwn}>
		<div class="flex h-8 w-8 shrink-0 items-end max-sm:hidden" class:justify-end={isOwn}>
			{#if showAvatar}
				{#if $profile?.picture}
					<img src={$profile.picture} alt={displayName} class="h-8 w-8 rounded-full object-cover" />
				{:else}
					<div
						class="h-8 w-8 rounded-full"
						style={`background-color: ${pubkeyToHexColor(message.author)}`}
					></div>
				{/if}
			{/if}
		</div>

		<div
			class="group flex max-w-[min(100%,48rem)] min-w-0 items-end gap-1.5 sm:gap-2"
			class:flex-row-reverse={isOwn}
		>
			<div class="relative flex min-w-0 flex-col gap-1.5" class:items-end={isOwn}>
				<TooltipProvider>
					<div
						class={cn(
							'absolute z-10 flex items-center gap-1 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
							reactionMenuOpen ? 'opacity-100' : 'opacity-0',
							actionSideClass
						)}
					>
						<Tooltip>
							<TooltipTrigger>
								{#snippet child({ props })}
									<Button
										{...props}
										type="button"
										variant="ghost"
										size="icon-sm"
										class="rounded-lg bg-background/90 shadow-sm backdrop-blur-sm"
										onclick={() => onReply(message)}
										aria-label="Reply to message"
									>
										<CornerUpLeft class="size-4" />
									</Button>
								{/snippet}
							</TooltipTrigger>
							<TooltipContent side="top" sideOffset={8}>Reply</TooltipContent>
						</Tooltip>

						<DropdownMenuRoot
							bind:open={reactionMenuOpen}
							onOpenChange={handleReactionMenuOpenChange}
						>
							<Tooltip>
								<TooltipTrigger>
									{#snippet child({ props })}
										<DropdownMenuTrigger {...props}>
											{#snippet child({ props: triggerProps })}
												<Button
													{...triggerProps}
													type="button"
													variant="ghost"
													size="icon-sm"
													class="rounded-lg bg-background/90 shadow-sm backdrop-blur-sm"
													aria-label="Add reaction"
												>
													<SmilePlus class="size-4" />
												</Button>
											{/snippet}
										</DropdownMenuTrigger>
									{/snippet}
								</TooltipTrigger>
								<TooltipContent side="top" sideOffset={8}>Add reaction</TooltipContent>
							</Tooltip>

							<DropdownMenuContent
								side="top"
								align={isOwn ? 'start' : 'end'}
								sideOffset={8}
								class="flex min-w-0 flex-row items-center gap-1 rounded-2xl p-1"
							>
								{#each availableReactions as reaction (reaction)}
									<DropdownMenuItem
										onSelect={() => onReact(message, reaction)}
										class="flex size-10 items-center justify-center rounded-xl p-0 text-lg"
									>
										{reaction}
									</DropdownMenuItem>
								{/each}
								<div class="ml-1 flex items-center gap-1 border-l border-border/70 pl-2">
									{#if customReactionOpen}
										<form
											class="flex items-center gap-1"
											onsubmit={async (event) => {
												event.preventDefault();
												await handleCustomReaction();
											}}
										>
											<Input
												bind:ref={customReactionInput}
												bind:value={customReaction}
												class="h-10 w-12 rounded-xl border border-border/70 bg-background px-2 text-center text-base"
												placeholder=""
												maxlength={8}
												aria-label="Custom reaction"
												oninput={() => {
													customReaction = normalizeCustomReaction(customReaction);
												}}
											/>
											<Button
												type="submit"
												variant="ghost"
												size="icon-sm"
												class="rounded-xl bg-background"
												aria-label="Confirm custom reaction"
											>
												<Plus class="size-4" />
											</Button>
										</form>
									{:else}
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											class="rounded-xl bg-background"
											aria-label="Show custom reaction input"
											onclick={() => {
												customReactionOpen = true;
											}}
										>
											<Plus class="size-4" />
										</Button>
									{/if}
								</div>
							</DropdownMenuContent>
						</DropdownMenuRoot>
					</div>
				</TooltipProvider>

				{#if showAuthor}
					<p
						class="max-w-[12rem] truncate px-1 text-xs font-medium text-foreground/90 sm:max-w-[16rem]"
					>
						{displayName}
					</p>
				{/if}

				<div data-message-id={message.id} class={bubbleClass}>
					{#if message.replyTo}
						<button
							type="button"
							class={cn(
								'mb-3 block w-full rounded-2xl border px-3 py-2 text-left transition-colors',
								isOwn
									? 'border-primary-foreground/20 bg-primary-foreground/12 text-primary-foreground hover:bg-primary-foreground/18'
									: 'border-border/70 bg-background/70 hover:bg-muted/80'
							)}
							onclick={() => onNavigateToMessage(message.replyTo!.id)}
						>
							<div class="flex items-center gap-1.5 text-xs font-medium">
								<span class={cn(isOwn ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
									Replying to
								</span>
								<span
									class={cn(
										'inline-flex min-w-0 items-center gap-2 rounded-full border px-2 py-1',
										isOwn
											? 'border-primary-foreground/25 bg-primary text-primary-foreground'
											: 'border-border/80 bg-background text-foreground'
									)}
								>
									<ProfileCard
										pubkey={message.replyTo.author}
										mode="inline"
										showInlineAvatar={true}
									/>
								</span>
							</div>
							<p
								class={cn(
									'line-clamp-2 text-sm break-words',
									isOwn ? 'text-primary-foreground/90' : 'text-foreground/80'
								)}
							>
								{message.replyTo.text}
							</p>
						</button>
					{/if}

					<p class="[overflow-wrap:anywhere] break-words whitespace-pre-wrap">{message.text}</p>
				</div>

				{#if message.reactions?.length}
					<div class="flex flex-wrap gap-2 px-1 pt-0.5" class:justify-end={isOwn}>
						{#each message.reactions as reaction (`${message.id}:${reaction.emoji}`)}
							<DropdownMenuRoot>
								<Tooltip>
									<TooltipTrigger>
										{#snippet child({ props })}
											<DropdownMenuTrigger {...props}>
												{#snippet child({ props: triggerProps })}
													<button
														{...triggerProps}
														type="button"
														class={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${reaction.reactedByMe ? 'border-primary/30 bg-primary/10 text-foreground hover:bg-primary/15' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
														aria-label={`React with ${reaction.emoji}. ${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}
														onclick={() => onReact(message, reaction.emoji)}
													>
														<span>{reaction.emoji}</span>
														<span>{reaction.count}</span>
													</button>
												{/snippet}
											</DropdownMenuTrigger>
										{/snippet}
									</TooltipTrigger>
									<TooltipContent side="top" sideOffset={8}>View reactions</TooltipContent>
								</Tooltip>

								<DropdownMenuContent
									side="top"
									align={isOwn ? 'start' : 'end'}
									sideOffset={8}
									class="min-w-44 rounded-xl p-3"
								>
									<div class="flex flex-col gap-2">
										{#each reaction.reactors as reactor (`${message.id}:${reaction.emoji}:${reactor}`)}
											<ProfileCard pubkey={reactor} mode="inline" showInlineAvatar={true} />
										{/each}
									</div>
								</DropdownMenuContent>
							</DropdownMenuRoot>
						{/each}
					</div>
				{/if}
			</div>

			<div
				class="flex shrink-0 items-center gap-1 px-1 text-[10px] text-muted-foreground/80 sm:text-[11px]"
			>
				<p>{message.timeLabel}</p>
				{#if message.isOwn && message.deliveryState === 'sent'}
					<span
						class="inline-flex items-center"
						aria-label={getDeliveryStateLabel()}
						title={getDeliveryStateLabel()}
					>
						<Check class="size-3" />
					</span>
				{:else if message.isOwn && message.deliveryState === 'error'}
					<span
						class="inline-flex items-center text-destructive"
						aria-label={getDeliveryStateLabel()}
						title={getDeliveryStateLabel()}
					>
						<X class="size-3" />
					</span>
				{:else if message.isOwn && message.deliveryState === 'sending'}
					<span aria-label={getDeliveryStateLabel()} title={getDeliveryStateLabel()}>…</span>
				{/if}
			</div>
		</div>
	</article>
</div>
