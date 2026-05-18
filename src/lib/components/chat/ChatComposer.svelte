<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '$lib/services/eventStore';
	import { ProfileModel } from 'applesauce-core/models';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Reply from '@lucide/svelte/icons/reply';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import X from '@lucide/svelte/icons/x';
	import { Metadata } from 'nostr-tools/kinds';
	import { pubkeyToHexColor } from '$lib/utils';

	let {
		value = $bindable(''),
		onSubmit,
		disabled = false,
		replyTo = null,
		onCancelReply = () => {},
		focusKey = 0
	}: {
		value?: string;
		onSubmit: () => void;
		disabled?: boolean;
		replyTo?: { author: string; authorLabel?: string; text: string } | null;
		onCancelReply?: () => void;
		focusKey?: number;
	} = $props();

	let textareaRef: HTMLTextAreaElement | null = $state(null);
	let expanded = $state(false);
	const replyProfile = $derived(replyTo ? eventStore.model(ProfileModel, replyTo.author) : null);
	const replyDisplayName = $derived.by(
		() =>
			replyTo &&
			($replyProfile?.name ||
				$replyProfile?.display_name ||
				$replyProfile?.nip05 ||
				replyTo.authorLabel ||
				`${replyTo.author.slice(0, 12)}…`)
	);

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (disabled) return;
		onSubmit();
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (disabled) return;
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			onSubmit();
		}
	}

	function handleInput(event: Event) {
		const target = event.currentTarget as HTMLTextAreaElement;
		target.style.height = 'auto';
		target.style.height = `${Math.min(target.scrollHeight, expanded ? 320 : 128)}px`;
	}

	function resizeTextarea() {
		if (!textareaRef) return;
		textareaRef.style.height = 'auto';
		textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, expanded ? 320 : 128)}px`;
		textareaRef.style.overflowY =
			textareaRef.scrollHeight > (expanded ? 320 : 128) ? 'auto' : 'hidden';
	}

	$effect(() => {
		focusKey;
		if (!textareaRef || disabled) return;
		textareaRef.focus();
		const length = textareaRef.value.length;
		textareaRef.setSelectionRange(length, length);
		resizeTextarea();
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
		expanded;
		resizeTextarea();
	});
</script>

<div class="border-t border-border bg-background">
	<form class="mx-auto max-w-5xl px-4 py-4 md:px-6" onsubmit={handleSubmit}>
		{#if replyTo}
			<div
				class="mb-3 flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2"
			>
				<div class="min-w-0">
					<div class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
						<Reply class="size-3.5" />
						<span>Replying to</span>
						<div
							class="inline-flex min-w-0 items-center gap-2 rounded-full border border-border/80 bg-background px-2 py-1 text-foreground"
						>
							{#if $replyProfile?.picture}
								<img
									src={$replyProfile.picture}
									alt={replyDisplayName}
									class="h-4 w-4 rounded-full object-cover"
								/>
							{:else}
								<div
									class="h-4 w-4 rounded-full"
									style={`background-color: ${pubkeyToHexColor(replyTo.author)}`}
								></div>
							{/if}
							<span class="max-w-32 truncate">{replyDisplayName}</span>
						</div>
					</div>
					<p class="truncate text-sm text-foreground/80">{replyTo.text}</p>
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

		<div class="flex items-end gap-3">
			<div class="flex flex-1 flex-col gap-2">
				<div class="flex justify-center">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="h-8 w-8 rounded-lg"
						onclick={() => (expanded = !expanded)}
						aria-label={expanded ? 'Collapse composer' : 'Expand composer'}
					>
						<ChevronUp class={`size-4 transition-transform ${expanded ? '' : 'rotate-180'}`} />
					</Button>
				</div>
				<Textarea
					bind:ref={textareaRef}
					bind:value
					placeholder="Type a message..."
					rows={expanded ? 6 : 1}
					{disabled}
					onkeydown={handleKeyDown}
					oninput={handleInput}
					class="min-h-11 w-full rounded-xl border border-input bg-card text-sm shadow-xs"
					style={`max-height: ${expanded ? 320 : 128}px; min-height: ${expanded ? 144 : 44}px;`}
				/>
			</div>
			<Button type="submit" class="h-11 rounded-xl px-4" disabled={disabled || !value.trim()}>
				<SendHorizontal class="size-4" />
				<span class="ml-2">Send</span>
			</Button>
		</div>
	</form>
</div>
