<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '$lib/services/eventStore';
	import { ProfileModel } from 'applesauce-core/models';
	import CornerUpLeft from '@lucide/svelte/icons/corner-up-left';
	import SmilePlus from '@lucide/svelte/icons/smile-plus';
	import { Metadata } from 'nostr-tools/kinds';
	import { pubkeyToHexColor } from '$lib/utils';
	import type { ChatMessage } from './chat.types';

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
	let reactionPickerOpen = $state(false);

	const isOwn = $derived(message.isOwn ?? false);
	const bubbleClass = $derived.by(
		() =>
			`max-w-full rounded-2xl border px-4 py-3 text-sm leading-7 shadow-sm transition-all ${
				isOwn ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card'
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
		if ($profile) return;
		const sub = addressLoader({
			kind: Metadata,
			pubkey: message.author,
			relays: metadataRelays
		}).subscribe();

		return () => sub.unsubscribe();
	});
</script>

<div class="flex flex-col gap-2">
	{#if showDayLabel}
		<p class="px-2 text-center text-[11px] font-medium text-muted-foreground">{message.dayLabel}</p>
	{/if}

	<article class="flex items-end gap-3" class:flex-row-reverse={isOwn}>
		<div class="flex h-8 w-8 shrink-0 items-end" class:justify-end={isOwn}>
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

		<div class="group flex max-w-3xl items-end gap-2" class:flex-row-reverse={isOwn}>
			<div class="relative flex min-w-0 flex-col gap-1" class:items-end={isOwn}>
				<div
					class="pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
					class:-left-18={!isOwn}
					class:-right-18={isOwn}
				>
					<div class="relative">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="pointer-events-auto h-8 w-8 rounded-lg bg-background/90 opacity-100 shadow-sm backdrop-blur-sm"
							onclick={() => {
								reactionPickerOpen = !reactionPickerOpen;
							}}
							aria-label="Add reaction"
						>
							<SmilePlus class="size-4" />
						</Button>

						{#if reactionPickerOpen}
							<div
								class="absolute bottom-full z-10 mb-2 flex items-center gap-1 rounded-xl border border-border bg-popover p-1 shadow-lg"
								class:right-0={isOwn}
							>
								{#each REACTIONS as reaction}
									<button
										type="button"
										class="flex h-9 w-9 items-center justify-center rounded-lg text-lg transition-colors hover:bg-accent hover:text-accent-foreground"
										onclick={async () => {
											reactionPickerOpen = false;
											await onReact(message, reaction);
										}}
										aria-label={`React with ${reaction}`}
									>
										{reaction}
									</button>
								{/each}
							</div>
						{/if}
					</div>

					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="pointer-events-auto h-8 w-8 rounded-lg bg-background/90 shadow-sm backdrop-blur-sm"
						onclick={() => onReply(message)}
						aria-label="Reply to message"
					>
						<CornerUpLeft class="size-4" />
					</Button>
				</div>

				{#if showAuthor}
					<p class="max-w-[16rem] truncate px-1 text-xs font-medium text-foreground">
						{displayName}
					</p>
				{/if}

				<div data-message-id={message.id} class={bubbleClass}>
					{#if message.replyTo}
						<button
							type="button"
							class="mb-3 block w-full rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-left"
							onclick={() => onNavigateToMessage(message.replyTo!.id)}
						>
							<p class="truncate text-xs font-medium text-muted-foreground">
								Replying to {message.replyTo.authorLabel ?? message.replyTo.author}
							</p>
							<p class="truncate text-sm text-foreground/80">{message.replyTo.text}</p>
						</button>
					{/if}

					<p class="[overflow-wrap:anywhere] break-words">{message.text}</p>
				</div>

				{#if message.reactions?.length}
					<div class="flex flex-wrap gap-2 px-1 pt-1" class:justify-end={isOwn}>
						{#each message.reactions as reaction (`${message.id}:${reaction.emoji}`)}
							<div class="group/reaction relative">
								<div
									class={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${reaction.reactedByMe ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border bg-muted/40 text-muted-foreground'}`}
								>
									<span>{reaction.emoji}</span>
									<span>{reaction.count}</span>
								</div>

								<div
									class="absolute bottom-full left-1/2 z-20 mb-2 hidden min-w-44 -translate-x-1/2 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg group-hover/reaction:block"
								>
									<div class="flex flex-col gap-2">
										{#each reaction.reactors as reactor (`${message.id}:${reaction.emoji}:${reactor}`)}
											<ProfileCard pubkey={reactor} mode="inline" showInlineAvatar={true} />
										{/each}
									</div>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<p class="shrink-0 text-[11px] text-muted-foreground">{message.timeLabel}</p>
		</div>
	</article>
</div>
