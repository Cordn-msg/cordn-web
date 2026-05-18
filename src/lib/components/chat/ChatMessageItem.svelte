<script lang="ts">
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '$lib/services/eventStore';
	import { ProfileModel } from 'applesauce-core/models';
	import { Metadata } from 'nostr-tools/kinds';
	import { pubkeyToHexColor } from '$lib/utils';
	import type { ChatMessage } from './chat.types';

	let {
		message,
		showAuthor = true,
		showAvatar = true,
		showDayLabel = false
	}: {
		message: ChatMessage;
		showAuthor?: boolean;
		showAvatar?: boolean;
		showDayLabel?: boolean;
	} = $props();

	const isOwn = $derived(message.isOwn ?? false);
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

		<div class="flex max-w-3xl items-end gap-2" class:flex-row-reverse={isOwn}>
			<div class="flex min-w-0 flex-col gap-1" class:items-end={isOwn}>
				{#if showAuthor}
					<p class="max-w-[16rem] truncate px-1 text-xs font-medium text-foreground">
						{displayName}
					</p>
				{/if}

				<div
					class="max-w-full rounded-2xl border border-border px-4 py-3 text-sm leading-7 shadow-sm"
					class:bg-primary={isOwn}
					class:text-primary-foreground={isOwn}
					class:border-primary={isOwn}
					class:bg-card={!isOwn}
				>
					<p class="[overflow-wrap:anywhere] break-words">{message.text}</p>
				</div>
			</div>

			<p class="shrink-0 text-[11px] text-muted-foreground">{message.timeLabel}</p>
		</div>
	</article>
</div>
