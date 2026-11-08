<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Input } from '$lib/components/ui/input';
	import CustomEmoji from './CustomEmoji.svelte';
	import { shortcode } from '$lib/chat/emoji';
	import { listEmojiPacks } from '$lib/services/chatEmojiPacks.svelte';

	/**
	 * The composer's custom emoji sheet: one section per active NIP-30 pack.
	 * Picking inserts the shortcode; the picture is attached when the message
	 * sends, so nothing is fetched by merely opening this.
	 */
	let { open = $bindable(false), onPick }: { open?: boolean; onPick: (value: string) => void } =
		$props();

	let query = $state('');
	const packs = $derived(listEmojiPacks());
	const sections = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return packs
			.map((pack) => ({
				...pack,
				emoji: needle
					? pack.emoji.filter((emoji) => emoji.name.toLowerCase().includes(needle))
					: pack.emoji
			}))
			.filter((pack) => pack.emoji.length > 0);
	});

	function pick(name: string) {
		onPick(shortcode(name));
		open = false;
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="bottom" class="data-[side=bottom]:h-[65dvh]">
		<Sheet.Header class="border-b px-4 pt-6 pb-3 text-left">
			<Sheet.Title class="text-base">Custom emoji</Sheet.Title>
			<Sheet.Description class="sr-only">Pick an emoji from your packs</Sheet.Description>
			<Input
				bind:value={query}
				type="search"
				placeholder="Search by name…"
				aria-label="Search emoji"
			/>
		</Sheet.Header>
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
			{#if packs.length === 0}
				<div
					class="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground"
				>
					<p>No emoji packs yet.</p>
					<a href={resolve('/chat/config/emoji')} class="font-medium text-foreground underline">
						Add a pack in settings
					</a>
				</div>
			{:else if sections.length === 0}
				<p class="py-8 text-center text-sm text-muted-foreground">No emoji match “{query}”.</p>
			{:else}
				<div class="space-y-5">
					{#each sections as pack (pack.coordinate)}
						<section>
							<h3
								class="mb-2 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase"
							>
								{pack.title}
							</h3>
							<div class="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
								{#each pack.emoji as emoji (emoji.name)}
									<button
										type="button"
										class="flex min-w-0 flex-col items-center gap-1 rounded-xl border border-border bg-card p-2 transition-colors hover:bg-muted/50"
										aria-label={`Insert :${emoji.name}:`}
										title={`:${emoji.name}:`}
										onclick={() => pick(emoji.name)}
									>
										<CustomEmoji
											display={{ name: emoji.name, url: emoji.url }}
											sizeClass="size-8"
										/>
										<span class="w-full truncate text-center text-[11px] text-muted-foreground">
											{emoji.name}
										</span>
									</button>
								{/each}
							</div>
						</section>
					{/each}
				</div>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
