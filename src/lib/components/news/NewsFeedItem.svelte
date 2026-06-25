<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import MarkdownContent from '$lib/components/MarkdownContent.svelte';
	import Heart from '@lucide/svelte/icons/heart';
	import type { NewsFeedItem } from '$lib/news/feedItems';

	let {
		item,
		unread = false,
		variant = 'compact',
		onDonate = () => {}
	}: {
		item: NewsFeedItem;
		unread?: boolean;
		/** Donation card layout. `compact` (slim row) is the default; `full` shows the body. */
		variant?: 'compact' | 'full';
		onDonate?: (config: NonNullable<NewsFeedItem['donation']>) => void;
	} = $props();

	const textAlignClass = $derived(
		item.align === 'center' ? 'text-center' : item.align === 'right' ? 'text-right' : 'text-left'
	);
	const headerJustifyClass = $derived(
		item.align === 'center'
			? 'justify-center'
			: item.align === 'right'
				? 'justify-end'
				: 'justify-start'
	);
</script>

{#if item.kind === 'release'}
	<div class="mx-auto w-full max-w-xl">
		<article
			class={`rounded-2xl border border-border bg-card px-5 py-4 shadow-sm ${textAlignClass}`}
		>
			<div class={`mb-1.5 flex items-center gap-2 ${headerJustifyClass}`}>
				<h2 class="text-base font-semibold tracking-tight text-foreground">{item.title}</h2>
				{#if unread}
					<span
						class="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
					>
						New
					</span>
				{/if}
			</div>
			<div class="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
				<MarkdownContent source={item.body} class="prose-sm" />
			</div>
		</article>
	</div>
{:else if item.donation}
	{#if variant === 'compact'}
		<div
			class="mx-auto flex w-full max-w-xl items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2"
		>
			<Heart class="size-3.5 shrink-0 text-muted-foreground" />
			<span class="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
				{item.donation.eyebrow}
			</span>
			<Button class="ml-auto" size="sm" variant="outline" onclick={() => onDonate(item.donation!)}>
				{item.donation.ctaLabel}
			</Button>
		</div>
	{:else}
		<div
			class="mx-auto flex w-full max-w-xl flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-muted/30 px-5 py-4 text-center"
		>
			<div class="flex items-center gap-2 text-muted-foreground">
				<Heart class="size-4" />
				<span class="text-[11px] font-semibold tracking-[0.18em] uppercase">
					{item.donation.eyebrow}
				</span>
			</div>
			<div class="prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
				<MarkdownContent source={item.donation.body} class="prose-sm" />
			</div>
			<Button size="sm" variant="outline" onclick={() => onDonate(item.donation!)}>
				{item.donation.ctaLabel}
			</Button>
		</div>
	{/if}
{/if}
