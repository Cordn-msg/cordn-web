<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { createQuery } from '@tanstack/svelte-query';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import {
		gifSearchQueryOptions,
		isGifsMediaUrl,
		normalizeGifQuery,
		GifRateLimitedError,
		type GifItem,
		type GifPreview
	} from '$lib/queries/gifSearch';
	import { externalLink } from '$lib/services/nativeShims';

	/**
	 * GIF picker sheet (gifs.nostr.build). Bottom sheet on every form factor — same
	 * pattern as the chat-header actions sheet. Picking inserts the item's original
	 * `url` into the composer; InlineMediaUrl renders it in the sent message.
	 */

	/** Starter queries shown as chips — the API has no trending endpoint (guide §5). */
	const STARTERS = ['gm', 'lol', 'yes', 'wow', 'applause', 'facepalm', 'love', 'fire'];

	let { open = $bindable(false), onPick }: { open?: boolean; onPick: (url: string) => void } =
		$props();

	let query = $state('');
	let debounced = $state('');
	let picked = false;

	// ~250 ms debounce (guide §5): search after typing settles.
	$effect(() => {
		const q = query;
		const timer = setTimeout(() => (debounced = q), 250);
		return () => clearTimeout(timer);
	});

	// One pick per opening: ignore double taps during the close animation (guide §8);
	// closing any other way resets the search so the next open starts from the starters.
	$effect(() => {
		if (open) {
			picked = false;
		} else {
			query = '';
			debounced = '';
		}
	});

	// Open on the first starter's results (guide §5); null (search disabled) only
	// while input is blank or a lone Latin letter.
	const trimmed = $derived(normalizeGifQuery(debounced));
	const effective = $derived(trimmed ?? (open ? STARTERS[0] : null));
	const results = createQuery(() => gifSearchQueryOptions(effective));

	// Static reads at mount are enough: the sheet remounts per opening.
	const reducedMotion =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	const widePreview = typeof matchMedia !== 'undefined' && matchMedia('(min-width: 640px)').matches;

	// LQIP backgrounds must be dropped once the preview paints — many GIFs are
	// transparent and the blur would show through (guide §4).
	const loadedPreviews = new SvelteSet<string>();

	function tilePreview(gif: GifItem): { src: string; width: number; height: number } {
		const preview: GifPreview = gif.previews[widePreview ? 'w480' : 'w240'] ?? gif.previews.medium;
		const animated =
			!reducedMotion && preview.animated && isGifsMediaUrl(preview.animated)
				? preview.animated
				: null;
		const still = preview.still && isGifsMediaUrl(preview.still) ? preview.still : null;
		return {
			src: animated ?? still ?? gif.url,
			// Coerced: remote JSON feeds a style attribute — never interpolate raw.
			width: Number(preview.width) || gif.width,
			height: Number(preview.height) || gif.height
		};
	}

	function pick(gif: GifItem) {
		if (picked || !isGifsMediaUrl(gif.url)) return;
		picked = true;
		open = false;
		onPick(gif.url);
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="bottom" class="data-[side=bottom]:h-[70dvh]">
		<Sheet.Header class="border-b px-4 pt-6 pb-3 text-left">
			<Sheet.Title class="text-base">Search GIFs</Sheet.Title>
			<Sheet.Description class="sr-only">Pick a GIF to insert into your message</Sheet.Description>
			<!-- No autofocus: on phones the keyboard would cover the grid (guide §8). -->
			<Input bind:value={query} type="search" placeholder="Search GIFs…" aria-label="Search GIFs" />
			<!-- Attribution is a condition of use (gifs.nostr.build guide §2) — keep visible. -->
			<p class="text-xs text-muted-foreground">
				GIFs from
				<a
					href="https://nostr.build"
					target="_blank"
					rel="noopener noreferrer"
					use:externalLink
					class="underline underline-offset-2"
				>
					nostr.build
				</a>
			</p>
		</Sheet.Header>
		<div class="flex flex-row gap-2 overflow-x-auto px-4 py-2" aria-label="Suggested GIF searches">
			{#each STARTERS as starter (starter)}
				<button
					type="button"
					class={cn(
						'shrink-0 rounded-full border px-3 py-1 text-xs transition-colors',
						trimmed === starter
							? 'border-primary bg-primary text-primary-foreground'
							: 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground'
					)}
					onclick={() => (query = starter)}
				>
					{starter}
				</button>
			{/each}
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
			{#if results.isFetching && !results.data}
				<!-- Skeleton grid -->
				<div class="columns-2 gap-2 sm:columns-3 sm:gap-3">
					{#each Array.from({ length: 8 }, (_, i) => i) as i (i)}
						<div
							class="mb-2 w-full animate-pulse break-inside-avoid rounded-xl bg-muted"
							style={`aspect-ratio: ${(i % 3) + 3} / ${(i % 2) + 2}`}
						></div>
					{/each}
				</div>
			{:else if results.error instanceof GifRateLimitedError}
				<div
					class="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground"
				>
					<p>Too many searches — wait a minute and try again.</p>
				</div>
			{:else if results.error}
				<div
					class="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground"
				>
					<p>GIF search is unavailable right now.</p>
					<Button variant="outline" size="sm" onclick={() => results.refetch()}>Retry</Button>
				</div>
			{:else if results.data && results.data.length === 0}
				<div
					class="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground"
				>
					<p>No GIFs for “{effective}”</p>
					<p class="text-xs">Try one of the suggestions above.</p>
				</div>
			{:else if results.data}
				<div class="columns-2 gap-2 sm:columns-3 sm:gap-3">
					{#each results.data as gif (gif.id)}
						{@const tile = tilePreview(gif)}
						<button
							type="button"
							class="relative mb-2 block w-full break-inside-avoid overflow-hidden rounded-xl bg-muted"
							style={`aspect-ratio: ${tile.width} / ${tile.height}`}
							aria-label={gif.title || 'GIF'}
							title={gif.title || 'GIF'}
							onclick={() => pick(gif)}
						>
							{#if gif.lqip && !loadedPreviews.has(gif.id)}
								<div
									class="absolute inset-0 scale-110 blur-xl"
									style={`background-image: url('${gif.lqip}')`}
								></div>
							{/if}
							<img
								src={tile.src}
								alt={gif.title || 'GIF'}
								loading="lazy"
								decoding="async"
								class="relative h-full w-full object-cover"
								onload={() => loadedPreviews.add(gif.id)}
							/>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
