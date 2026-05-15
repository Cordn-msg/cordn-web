<script lang="ts">
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '$lib/services/eventStore';
	import { ProfileModel } from 'applesauce-core/models';
	import { Metadata } from 'nostr-tools/kinds';
	import { pubkeyToHexColor } from '$lib/utils';
	import type { ChatMessage } from './chat.types';

	let { message }: { message: ChatMessage } = $props();

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

<article class="flex gap-3" class:flex-row-reverse={isOwn}>
	<div class="flex max-w-3xl flex-col gap-1" class:items-end={isOwn}>
		<div
			class="flex items-center gap-2 px-1 text-xs text-muted-foreground"
			class:flex-row-reverse={isOwn}
		>
			<span>{message.timestamp}</span>
		</div>

		<div
			class="max-w-full rounded-2xl border border-border px-4 py-3 text-sm leading-7 shadow-sm"
			class:bg-primary={isOwn}
			class:text-primary-foreground={isOwn}
			class:border-primary={isOwn}
			class:bg-card={!isOwn}
		>
			<div class="mb-3 flex items-center gap-3" class:flex-row-reverse={isOwn}>
				{#if $profile?.picture}
					<img src={$profile.picture} alt={displayName} class="h-8 w-8 rounded-full object-cover" />
				{:else}
					<div
						class="h-8 w-8 rounded-full"
						style={`background-color: ${pubkeyToHexColor(message.author)}`}
					></div>
				{/if}

				<div class="min-w-0" class:text-right={isOwn}>
					<p class="truncate text-sm font-semibold" class:text-primary-foreground={isOwn}>
						{displayName}
					</p>
					<p class="truncate text-[11px] opacity-70">{message.author}</p>
				</div>
			</div>

			<p class="[overflow-wrap:anywhere] break-words">{message.text}</p>
		</div>
	</div>
</article>
