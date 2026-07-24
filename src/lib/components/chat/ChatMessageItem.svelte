<script lang="ts" module>
	let sharedSavedReactions = $state<string[] | null>(null);
	let activeTouchActionsMessageId = $state<string | null>(null);
</script>

<script lang="ts">
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
	import Avatar from '$lib/components/Avatar.svelte';
	import { useProfile } from '$lib/services/useProfile.svelte';
	import { nip19 } from 'nostr-tools';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Download from '@lucide/svelte/icons/download';
	import CornerUpLeft from '@lucide/svelte/icons/corner-up-left';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Info from '@lucide/svelte/icons/info';
	import Pencil from '@lucide/svelte/icons/pencil';
	import MessageCirclePlus from '@lucide/svelte/icons/message-circle-plus';
	import SmilePlus from '@lucide/svelte/icons/smile-plus';
	import Pin from '@lucide/svelte/icons/pin';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import { cn, copyToClipboard, downloadObjectUrl } from '$lib/utils';
	import { externalLink } from '$lib/services/nativeShims';
	import type { ChatMessage } from './chat.types';
	import ChatInlineBody from '$lib/chat/ChatInlineBody.svelte';
	import ChatMessageMedia from './ChatMessageMedia.svelte';
	import { peekMessageMedia, resolveMessageMedia } from '$lib/services/chatMediaStorage.svelte';
	import {
		MESSAGE_LINK_WRAP_CLASS,
		MESSAGE_PART_CONTAINER_CLASS,
		MESSAGE_TEXT_WRAP_CLASS
	} from '$lib/chat/messageTextClasses';
	import {
		getCachedChatMessageParts,
		loadCustomChatReactions,
		saveCustomChatReactions
	} from './chatMessageRenderCache';

	const REACTIONS = ['👍', '❤️', '😂', '😮', '🎉', '🔥'] as const;

	let {
		message,
		showAuthor = true,
		showAvatar = true,
		showDayLabel = false,
		onReply = () => {},
		onReact = () => Promise.resolve(),
		onEdit = () => {},
		onDelete = () => Promise.resolve(),
		onRetrySend = () => {},
		onNavigateToMessage = () => {},
		onOpenRich = () => {},
		onPin = () => {},
		highlighted = false
	}: {
		message: ChatMessage;
		showAuthor?: boolean;
		showAvatar?: boolean;
		showDayLabel?: boolean;
		onReply?: (message: ChatMessage) => void;
		onReact?: (message: ChatMessage, reaction: string) => void | Promise<void>;
		onEdit?: (message: ChatMessage) => void;
		onDelete?: (message: ChatMessage) => void | Promise<void>;
		onRetrySend?: (message: ChatMessage) => void | Promise<void>;
		onNavigateToMessage?: (messageId: string) => void;
		onOpenRich?: (eventId: string) => void;
		onPin?: (message: ChatMessage) => void;
		highlighted?: boolean;
	} = $props();
	let reactionMenuOpen = $state(false);
	let actionsMenuOpen = $state(false);
	let customReactionOpen = $state(false);
	let customReaction = $state('');
	let customReactionInput: HTMLInputElement | null = $state(null);
	let interactionControlsActive = $state(false);
	let touchStartX = 0;
	let touchStartY = 0;
	let swipeOffset = $state(0);
	let isDragging = $state(false);

	const SWIPE_REPLY_THRESHOLD = 56;
	const SWIPE_MAX_OFFSET = 72;
	const GESTURE_MOVE_TOLERANCE = 10;

	const isOwn = $derived(message.isOwn ?? false);
	const actionSideClass = $derived(
		isOwn
			? 'right-0 top-0 -translate-y-[calc(100%+0.35rem)] sm:right-full sm:top-3 sm:translate-y-0 sm:mr-2'
			: 'left-0 top-0 -translate-y-[calc(100%+0.35rem)] sm:left-full sm:top-3 sm:translate-y-0 sm:ml-2'
	);
	const savedReactions = $derived(sharedSavedReactions ?? []);
	const availableReactions = $derived.by(() => [...REACTIONS, ...savedReactions]);
	const mobileActionsVisible = $derived(activeTouchActionsMessageId === message.id);
	const shouldMountInteractionControls = $derived(
		interactionControlsActive ||
			reactionMenuOpen ||
			actionsMenuOpen ||
			customReactionOpen ||
			mobileActionsVisible
	);
	const replySwipeDirection = $derived(isOwn ? -1 : 1);
	const replySwipeProgress = $derived(Math.min(Math.abs(swipeOffset) / SWIPE_REPLY_THRESHOLD, 1));
	const replySwipeActive = $derived(Math.abs(swipeOffset) >= SWIPE_REPLY_THRESHOLD);
	const swipeTransform = $derived(swipeOffset ? `translateX(${swipeOffset}px)` : 'translateX(0px)');
	const replyIndicatorSideClass = $derived(isOwn ? 'right-full mr-2' : 'left-full ml-2');
	const isSystemMessage = $derived(Boolean(message.systemKind));
	const systemMessageIcon = $derived.by(() => {
		switch (message.systemKind) {
			case 'member-added':
				return Plus;
			case 'member-removed':
				return X;
			case 'metadata-changed':
				return Pencil;
			default:
				return Info;
		}
	});
	function getDeliveryStateLabel() {
		if (message.deliveryState === 'sending') return 'Sending';
		if (message.deliveryState === 'sent') return 'Sent';
		if (message.deliveryState === 'error') return 'Failed';
		return '';
	}
	const bubbleClass = $derived.by(
		() =>
			`min-w-0 max-w-full overflow-hidden rounded-3xl border px-3 py-2.5 text-sm leading-6 shadow-sm transition-all sm:px-4 sm:py-3 sm:leading-7 ${
				isOwn
					? message.deliveryState === 'error'
						? 'border-destructive/40 bg-primary text-primary-foreground'
						: 'border-primary bg-primary text-primary-foreground'
					: 'border-border bg-card'
			} ${highlighted ? 'border-amber-400 bg-amber-50/70 ring-4 ring-amber-300/35 shadow-xl scale-[1.015] animate-pulse' : ''}`
	);
	const profileState = useProfile(() => message.author);
	const profile = $derived(profileState.current);
	const authorNpub = $derived(nip19.npubEncode(message.author));
	const displayName = $derived.by(
		() => profile?.name || profile?.display_name || profile?.nip05 || `${authorNpub.slice(0, 12)}…`
	);
	const replyParts = $derived.by(() =>
		message.replyTo ? getCachedChatMessageParts(message.replyTo.id, message.replyTo.text) : []
	);

	$effect(() => {
		if (!reactionMenuOpen || !customReactionOpen || !customReactionInput) return;
		customReactionInput.focus();
	});

	$effect(() => {
		if (sharedSavedReactions === null) {
			sharedSavedReactions = loadCustomChatReactions();
		}
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
		sharedSavedReactions = [...savedReactions, reaction];
		saveCustomChatReactions(sharedSavedReactions);
	}

	function activateInteractionControls() {
		interactionControlsActive = true;
	}

	function showTouchActions() {
		activateInteractionControls();
		activeTouchActionsMessageId = message.id;
	}

	function clearTouchActions() {
		if (activeTouchActionsMessageId === message.id) {
			activeTouchActionsMessageId = null;
		}
	}

	function handleReplyAction() {
		if (message.deleted) return;
		actionsMenuOpen = false;
		clearTouchActions();
		onReply(message);
	}

	function handleShowCustomReactionInput() {
		showTouchActions();
		reactionMenuOpen = true;
		customReactionOpen = true;
	}

	async function handleCustomReaction() {
		if (message.deleted) return;

		const reaction = normalizeCustomReaction(customReaction);
		if (!reaction) return;
		persistCustomReaction(reaction);
		await onReact(message, reaction);
		customReaction = '';
		customReactionOpen = false;
		reactionMenuOpen = false;
		clearTouchActions();
	}

	function startEditing() {
		if (!isOwn || message.deleted) return;
		actionsMenuOpen = false;
		clearTouchActions();
		onEdit(message);
	}

	function handleReactionMenuOpenChange(open: boolean) {
		reactionMenuOpen = open;
		if (open) {
			showTouchActions();
		}
		if (!open) {
			customReactionOpen = false;
			customReaction = '';
		}
	}

	function handleActionsMenuOpenChange(open: boolean) {
		actionsMenuOpen = open;
		if (open) showTouchActions();
		if (!open) {
			reactionMenuOpen = false;
			customReactionOpen = false;
			customReaction = '';
			clearTouchActions();
		}
	}

	function openRich() {
		actionsMenuOpen = false;
		clearTouchActions();
		onOpenRich(message.eventId);
	}

	async function handleCopyMessage() {
		if (message.deleted) return;
		actionsMenuOpen = false;
		clearTouchActions();
		await copyToClipboard(message.text);
	}

	const hasDownloadableMedia = $derived(
		Boolean(message.media || (message.tags && peekMessageMedia(message.tags)))
	);

	async function handleDownloadMedia() {
		actionsMenuOpen = false;
		clearTouchActions();
		// Optimistic (still uploading): fall back to the local preview if present.
		if (message.media) {
			if (message.media.previewUrl)
				downloadObjectUrl(message.media.previewUrl, message.media.filename);
			return;
		}
		if (!message.tags || !message.mediaKeyBase64) return;
		const resolved = await resolveMessageMedia({
			messageId: message.eventId,
			tags: message.tags,
			mediaKeyBase64: message.mediaKeyBase64
		});
		if (resolved) downloadObjectUrl(resolved.url, resolved.filename);
	}

	async function deleteMessage() {
		if (!isOwn || message.deleted) return;
		actionsMenuOpen = false;
		clearTouchActions();
		await onDelete(message);
	}

	function handlePinAction() {
		if (message.deleted) return;
		actionsMenuOpen = false;
		clearTouchActions();
		onPin(message);
	}

	function getReactionLabel(reaction: NonNullable<ChatMessage['reactions']>[number]) {
		if (!reaction.reactors.length) return 'Toggle reaction';
		return reaction.reactors.join('\n');
	}

	function resetGesture() {
		isDragging = false;
		swipeOffset = 0;
	}

	function isCoarsePointer(event: PointerEvent) {
		return event.pointerType === 'touch' || event.pointerType === 'pen';
	}

	function handleBubblePointerDown(event: PointerEvent) {
		if (!isCoarsePointer(event)) return;
		if (event.button !== 0) return;

		touchStartX = event.clientX;
		touchStartY = event.clientY;
		swipeOffset = 0;
		isDragging = false;
	}

	function handleBubblePointerMove(event: PointerEvent) {
		if (!isCoarsePointer(event)) return;
		const deltaX = event.clientX - touchStartX;
		const deltaY = event.clientY - touchStartY;
		const horizontalDistance = Math.abs(deltaX);
		const verticalDistance = Math.abs(deltaY);

		if (verticalDistance > horizontalDistance && verticalDistance > GESTURE_MOVE_TOLERANCE) {
			resetGesture();
			return;
		}

		if (horizontalDistance <= GESTURE_MOVE_TOLERANCE) return;

		const directedOffset = deltaX * replySwipeDirection > 0 ? deltaX : 0;
		isDragging = directedOffset !== 0;
		swipeOffset = Math.max(-SWIPE_MAX_OFFSET, Math.min(SWIPE_MAX_OFFSET, directedOffset));
	}

	function handleBubblePointerUp(event: PointerEvent) {
		if (!isCoarsePointer(event)) return;

		if (!message.deleted && Math.abs(swipeOffset) >= SWIPE_REPLY_THRESHOLD) {
			onReply(message);
			resetGesture();
			return;
		}

		if (Math.abs(swipeOffset) < GESTURE_MOVE_TOLERANCE) {
			showTouchActions();
		}

		resetGesture();
	}

	function handleBubblePointerCancel() {
		resetGesture();
	}
</script>

<div class="flex flex-col gap-2">
	{#if showDayLabel}
		<p class="px-2 text-center text-[11px] font-medium text-muted-foreground">{message.dayLabel}</p>
	{/if}

	{#if isSystemMessage}
		<div
			class="flex items-center justify-center gap-2 px-2 py-1 text-xs text-muted-foreground"
			data-message-id={message.id}
		>
			{#snippet icon()}
				{@const IconComponent = systemMessageIcon}
				<IconComponent class="size-3.5 shrink-0 text-muted-foreground/60" />
			{/snippet}
			{@render icon()}
			<span class="inline-flex items-center gap-1">
				{#if message.systemKind === 'member-added'}
					{#if message.systemCommitter}
						<ProfileCard
							pubkey={message.systemCommitter}
							mode="inline"
							showInlineAvatar={false}
							profileLink={false}
						/>
					{:else}
						<span>Someone</span>
					{/if}
					added
					{#if message.systemTarget}
						<ProfileCard
							pubkey={message.systemTarget}
							mode="inline"
							showInlineAvatar={false}
							profileLink={false}
						/>
					{/if}
					to the group
				{:else if message.systemKind === 'member-removed'}
					{#if message.systemCommitter}
						<ProfileCard
							pubkey={message.systemCommitter}
							mode="inline"
							showInlineAvatar={false}
							profileLink={false}
						/>
					{:else}
						<span>Someone</span>
					{/if}
					removed
					{#if message.systemTarget}
						<ProfileCard
							pubkey={message.systemTarget}
							mode="inline"
							showInlineAvatar={false}
							profileLink={false}
						/>
					{/if}
					from the group
				{:else if message.systemKind === 'metadata-changed'}
					{#if message.systemCommitter}
						<ProfileCard
							pubkey={message.systemCommitter}
							mode="inline"
							showInlineAvatar={false}
							profileLink={false}
						/>
					{:else}
						<span>Someone</span>
					{/if}
					changed {message.systemDetail ?? 'group settings'}
				{/if}
			</span>
			<span class="text-[10px] text-muted-foreground/50">{message.timeLabel}</span>
		</div>
	{:else}
		<article class="flex min-w-0 items-end gap-2 sm:gap-3" class:flex-row-reverse={isOwn}>
			<div class="flex h-8 w-8 shrink-0 items-end" class:justify-end={isOwn}>
				{#if showAvatar}
					<Avatar
						pubkey={message.author}
						picture={profile?.picture}
						size="h-8 w-8"
						alt={displayName}
					/>
				{:else}
					<div class="h-8 w-8" aria-hidden="true"></div>
				{/if}
			</div>

			<div
				role="presentation"
				class="group flex max-w-[min(100%,48rem)] min-w-0 flex-1 items-end gap-1.5 sm:gap-2"
				class:flex-row-reverse={isOwn}
				onpointerenter={activateInteractionControls}
				onfocusin={activateInteractionControls}
				onclick={() => {
					if (mobileActionsVisible || actionsMenuOpen || reactionMenuOpen) return;
					clearTouchActions();
				}}
			>
				<div class="relative flex max-w-full min-w-0 flex-col gap-1.5" class:items-end={isOwn}>
					{#if shouldMountInteractionControls}
						<TooltipProvider>
							<div
								class={cn(
									'absolute z-10 flex items-center gap-1 transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100',
									mobileActionsVisible || reactionMenuOpen || actionsMenuOpen
										? 'opacity-100'
										: 'opacity-0 sm:opacity-0',
									actionSideClass
								)}
							>
								{#if !message.deleted}
									<Tooltip>
										<TooltipTrigger>
											{#snippet child({ props })}
												<Button
													{...props}
													type="button"
													variant="ghost"
													size="icon-sm"
													class="hidden rounded-lg bg-background/90 shadow-sm backdrop-blur-sm sm:inline-flex"
													onclick={() => onReply(message)}
													aria-label="Reply to message"
												>
													<CornerUpLeft class="size-4" />
												</Button>
											{/snippet}
										</TooltipTrigger>
										<TooltipContent side="top" sideOffset={8}>Reply</TooltipContent>
									</Tooltip>
								{/if}

								{#if !message.deleted}
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										class="rounded-lg bg-background/90 shadow-sm backdrop-blur-sm sm:hidden"
										onclick={(event) => {
											event.stopPropagation();
											handleReplyAction();
										}}
										aria-label="Reply to message"
									>
										<MessageCirclePlus class="size-4" />
									</Button>
								{/if}

								{#if !message.deleted}
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
																onclick={(event) => event.stopPropagation()}
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
											class="flex min-w-0 flex-row items-start gap-1 rounded-2xl p-1"
										>
											<div class="grid max-h-[172px] grid-cols-6 gap-1 overflow-y-auto">
												{#each availableReactions as reaction (reaction)}
													<DropdownMenuItem
														onSelect={async () => {
															await onReact(message, reaction);
															clearTouchActions();
														}}
														class="flex size-10 items-center justify-center rounded-xl p-0 text-lg"
													>
														{reaction}
													</DropdownMenuItem>
												{/each}
											</div>
											<div class="flex items-center gap-1 border-l border-border/70 pl-2">
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
														onclick={handleShowCustomReactionInput}
													>
														<Plus class="size-4" />
													</Button>
												{/if}
											</div>
										</DropdownMenuContent>
									</DropdownMenuRoot>
								{/if}

								<Tooltip>
									<TooltipTrigger>
										{#snippet child({ props })}
											<Button
												{...props}
												type="button"
												variant="ghost"
												size="icon-sm"
												class="rounded-lg bg-background/90 shadow-sm backdrop-blur-sm"
												onclick={() => openRich()}
												aria-label="Message info"
											>
												<Info class="size-4" />
											</Button>
										{/snippet}
									</TooltipTrigger>
									<TooltipContent side="top" sideOffset={8}>Info</TooltipContent>
								</Tooltip>

								<DropdownMenuRoot
									bind:open={actionsMenuOpen}
									onOpenChange={handleActionsMenuOpenChange}
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
															aria-label="Open message actions"
															onclick={(event) => event.stopPropagation()}
														>
															<Ellipsis class="size-4" />
														</Button>
													{/snippet}
												</DropdownMenuTrigger>
											{/snippet}
										</TooltipTrigger>
										<TooltipContent side="top" sideOffset={8}>More</TooltipContent>
									</Tooltip>

									<DropdownMenuContent
										side="top"
										align={isOwn ? 'start' : 'end'}
										sideOffset={8}
										class="w-44 rounded-xl"
									>
										<DropdownMenuItem onSelect={handleCopyMessage} class="gap-2">
											<Copy class="size-4" />
											<span>Copy</span>
										</DropdownMenuItem>

										{#if hasDownloadableMedia}
											<DropdownMenuItem onSelect={handleDownloadMedia} class="gap-2">
												<Download class="size-4" />
												<span>Download</span>
											</DropdownMenuItem>
										{/if}

										{#if !message.deleted}
											<DropdownMenuItem onSelect={handlePinAction} class="gap-2">
												<Pin class="size-4" />
												<span>{message.pinned ? 'Unpin' : 'Pin'}</span>
											</DropdownMenuItem>
										{/if}

										{#if !message.deleted}
											<DropdownMenuItem onSelect={handleReplyAction} class="gap-2 sm:hidden">
												<CornerUpLeft class="size-4" />
												<span>Reply</span>
											</DropdownMenuItem>
										{/if}

										{#if isOwn && !message.deleted}
											<DropdownMenuItem onSelect={startEditing} class="gap-2">
												<Pencil class="size-4" />
												<span>Edit</span>
											</DropdownMenuItem>
											<DropdownMenuItem onSelect={deleteMessage} class="gap-2 text-destructive">
												<Trash2 class="size-4" />
												<span>Delete</span>
											</DropdownMenuItem>
										{/if}
									</DropdownMenuContent>
								</DropdownMenuRoot>
							</div>
						</TooltipProvider>
					{/if}

					{#if showAuthor}
						<p
							class="max-w-[12rem] truncate px-1 text-xs font-medium text-foreground/90 sm:max-w-[16rem]"
						>
							{displayName}
						</p>
					{/if}

					<div class="relative max-w-full min-w-0">
						<div
							role="group"
							data-message-id={message.id}
							class={cn(
								bubbleClass,
								'relative z-10 w-full max-w-full min-w-0 touch-pan-y select-text'
							)}
							style={`transform: ${swipeTransform}; ${
								isDragging ? '' : 'transition: transform 150ms ease-out;'
							}`}
							onpointerdown={handleBubblePointerDown}
							onpointermove={handleBubblePointerMove}
							onpointerup={handleBubblePointerUp}
							onpointercancel={handleBubblePointerCancel}
							onpointerleave={handleBubblePointerCancel}
						>
							<div
								class={cn(
									'pointer-events-none absolute top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border bg-background/95 text-muted-foreground shadow-sm sm:hidden',
									replyIndicatorSideClass,
									replySwipeActive ? 'border-primary text-primary' : 'border-border'
								)}
								style={`opacity: ${replySwipeProgress}; transform: translateY(-50%) scale(${0.85 + replySwipeProgress * 0.15});`}
								aria-hidden="true"
							>
								<CornerUpLeft class={cn('size-4', isOwn ? 'rotate-180' : '')} />
							</div>

							{#if message.deleted}
								<div
									class={cn(
										'rounded-2xl border border-dashed px-3 py-2 text-sm italic',
										isOwn
											? 'border-primary-foreground/25 text-primary-foreground/80'
											: 'border-border/80 text-muted-foreground'
									)}
								>
									This message was deleted
								</div>
							{:else if message.replyTo}
								<button
									type="button"
									class={cn(
										'mb-3 block max-w-full min-w-0 rounded-2xl border px-3 py-2 text-left transition-colors',
										isOwn
											? 'border-primary-foreground/20 bg-primary-foreground/12 text-primary-foreground hover:bg-primary-foreground/18'
											: 'border-border/70 bg-background/70 hover:bg-muted/80'
									)}
									onclick={() => onNavigateToMessage(message.replyTo!.id)}
								>
									<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-medium">
										<span
											class={cn(isOwn ? 'text-primary-foreground/80' : 'text-muted-foreground')}
										>
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
												profileLink={false}
											/>
										</span>
									</div>
									{#if message.replyTo.deleted}
										<p
											class={cn(
												'line-clamp-2 max-w-full min-w-0 text-sm italic',
												isOwn ? 'text-primary-foreground/70' : 'text-muted-foreground'
											)}
										>
											This message was deleted
										</p>
									{:else}
										<p
											class={cn(
												`line-clamp-2 max-w-full min-w-0 text-sm ${MESSAGE_TEXT_WRAP_CLASS}`,
												isOwn ? 'text-primary-foreground/90' : 'text-foreground/80'
											)}
										>
											{#each replyParts as part, index (`${message.id}:reply-part:${index}`)}
												{#if part.type === 'profile'}
													<span
														class={cn(
															'inline-flex max-w-full min-w-0 rounded-full font-semibold',
															MESSAGE_PART_CONTAINER_CLASS
														)}
													>
														@<ProfileCard pubkey={part.pubkey} mode="inline" profileLink={false} />
													</span>
												{:else if part.type === 'link'}
													<a
														href={part.href}
														target="_blank"
														rel="external noreferrer noopener"
														use:externalLink
														class={cn(
															MESSAGE_LINK_WRAP_CLASS,
															isOwn
																? 'text-primary-foreground hover:text-primary-foreground/80'
																: 'text-foreground hover:text-foreground/80'
														)}
													>
														{part.text}
													</a>
												{:else}
													<span class={MESSAGE_PART_CONTAINER_CLASS}>{part.text}</span>
												{/if}
											{/each}
										</p>
									{/if}
								</button>
							{/if}

							{#if !message.deleted}
								<ChatMessageMedia {message} />
								<ChatInlineBody {message} {onOpenRich} />
							{/if}
						</div>
					</div>

					{#if !message.deleted && message.reactions?.length}
						<div class="flex flex-wrap gap-2 px-1 pt-0.5" class:justify-end={isOwn}>
							{#each message.reactions as reaction (`${message.id}:${reaction.emoji}`)}
								<Tooltip>
									<TooltipTrigger>
										{#snippet child({ props })}
											<button
												{...props}
												type="button"
												class={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${reaction.reactedByMe ? 'border-primary/30 bg-primary/10 text-foreground hover:bg-primary/15' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
												aria-label={`${reaction.emoji}: ${reaction.count} reaction${reaction.count === 1 ? '' : 's'}. Tap to see who reacted.`}
												title={getReactionLabel(reaction)}
												onclick={() => openRich()}
												onpointerenter={activateInteractionControls}
												onfocus={activateInteractionControls}
											>
												<span>{reaction.emoji}</span>
												<span>{reaction.count}</span>
											</button>
										{/snippet}
									</TooltipTrigger>
									<TooltipContent side="top" sideOffset={8}>
										<div class="flex flex-col gap-2">
											{#each reaction.reactors as reactor (`${message.id}:${reaction.emoji}:${reactor}`)}
												<ProfileCard
													pubkey={reactor}
													mode="inline"
													showInlineAvatar={true}
													profileLink={false}
												/>
											{/each}
										</div>
									</TooltipContent>
								</Tooltip>
							{/each}
						</div>
					{/if}
				</div>

				<div
					class="flex shrink-0 items-center gap-1 self-end px-1 text-[10px] text-muted-foreground/80 sm:text-[11px]"
				>
					<p>{message.timeLabel}</p>
					{#if message.pinned}
						<span class="inline-flex items-center" aria-label="Pinned" title="Pinned">
							<Pin class="size-3" />
						</span>
					{/if}
					{#if message.edited}
						<span class="inline-flex items-center" aria-label="Edited" title="Edited">
							<Pencil class="size-3" />
						</span>
					{/if}
					{#if message.isOwn && message.deliveryState === 'sent'}
						<span
							class="inline-flex items-center"
							aria-label={getDeliveryStateLabel()}
							title={getDeliveryStateLabel()}
						>
							<Check class="size-3" />
						</span>
					{:else if message.isOwn && message.deliveryState === 'error'}
						<button
							type="button"
							class="inline-flex items-center text-destructive hover:text-destructive/80"
							aria-label={message.media ? 'Remove failed upload' : 'Retry send'}
							title={message.media
								? 'Upload failed — tap to remove'
								: 'Failed to send — click to retry'}
							onclick={() => onRetrySend(message)}
						>
							<X class="size-3" />
						</button>
					{:else if message.isOwn && message.deliveryState === 'sending'}
						<span aria-label={getDeliveryStateLabel()} title={getDeliveryStateLabel()}>…</span>
					{/if}
				</div>
			</div>
		</article>
	{/if}
</div>
