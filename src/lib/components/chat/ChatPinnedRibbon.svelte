<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import ChatMessagePreview from './ChatMessagePreview.svelte';
	import Pin from '@lucide/svelte/icons/pin';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Menu from '@lucide/svelte/icons/menu';
	import type { ChatMessage } from './chat.types';

	let {
		messages,
		onJumpToMessage,
		onUnpin
	}: {
		messages: ChatMessage[];
		onJumpToMessage: (messageId: string) => void;
		onUnpin?: (message: ChatMessage) => void;
	} = $props();

	let index = $state(0);
	let dialogOpen = $state(false);

	// Cursor can lag a shrinking pin list — clamp reactively instead of
	// mutating state in an effect.
	const safeIndex = $derived(messages.length ? Math.min(index, messages.length - 1) : 0);
	const current = $derived(messages[safeIndex]);
	const positionLabel = $derived(`${safeIndex + 1}/${messages.length}`);
</script>

{#if current}
	<div
		class="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-2 py-1.5 sm:px-4 md:px-6"
	>
		<Pin class="size-3.5 shrink-0 text-muted-foreground" />

		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-muted/60"
			title="Jump to pinned message"
			onclick={() => onJumpToMessage(current.id)}
		>
			<span class="shrink-0 text-xs font-medium text-muted-foreground">
				<ProfileCard
					pubkey={current.author}
					mode="inline"
					showInlineAvatar={true}
					profileLink={false}
				/>
			</span>
			<span class="min-w-0 flex-1">
				<ChatMessagePreview message={current} class="line-clamp-1 text-muted-foreground" />
			</span>
		</button>

		{#if messages.length > 1}
			<div class="flex shrink-0 items-center gap-0.5">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Previous pinned message"
					onclick={() => (index = (index - 1 + messages.length) % messages.length)}
				>
					<ChevronLeft class="size-4" />
				</Button>
				<span class="min-w-10 text-center text-xs text-muted-foreground tabular-nums">
					{positionLabel}
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Next pinned message"
					onclick={() => (index = (index + 1) % messages.length)}
				>
					<ChevronRight class="size-4" />
				</Button>
			</div>
		{/if}

		<Button
			variant="ghost"
			size="icon-sm"
			class="shrink-0"
			aria-label="Show all pinned messages"
			title="All pinned messages"
			onclick={() => (dialogOpen = true)}
		>
			<Menu class="size-4" />
		</Button>
	</div>

	<Dialog.Root bind:open={dialogOpen}>
		<Dialog.Content class="sm:max-w-lg">
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<Pin class="size-4" />
					Pinned messages
				</Dialog.Title>
				<Dialog.Description>
					{messages.length} pinned message{messages.length === 1 ? '' : 's'} in this group
				</Dialog.Description>
			</Dialog.Header>

			<div class="max-h-[60vh] space-y-2 overflow-y-auto">
				{#each messages as message (message.id)}
					<div class="rounded-xl border border-border p-3">
						<div class="mb-1.5 flex items-center justify-between gap-2">
							<ProfileCard
								pubkey={message.author}
								mode="inline"
								showInlineAvatar={true}
								profileLink={false}
							/>
							{#if onUnpin}
								<Button variant="ghost" size="sm" onclick={() => onUnpin(message)}>Unpin</Button>
							{/if}
						</div>
						{#if message.pinnedBy}
							<p
								class="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground"
								title="Pinned by"
							>
								<Pin class="size-3 shrink-0" />
								Pinned by
								<ProfileCard
									pubkey={message.pinnedBy}
									mode="inline"
									showInlineAvatar={true}
									profileLink={false}
								/>
							</p>
						{/if}
						<button
							type="button"
							class="block w-full text-left"
							onclick={() => {
								dialogOpen = false;
								onJumpToMessage(message.id);
							}}
						>
							<ChatMessagePreview {message} class="line-clamp-3 text-sm text-foreground" />
							<span class="mt-1 inline-block text-xs text-muted-foreground">Jump to message</span>
						</button>
					</div>
				{/each}
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
