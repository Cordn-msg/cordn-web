<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import Heart from '@lucide/svelte/icons/heart';
	import type { NewsFeedItem } from '$lib/news/feedItems';

	let {
		item,
		unread = false,
		onDonate = () => {}
	}: {
		item: NewsFeedItem;
		unread?: boolean;
		onDonate?: () => void;
	} = $props();

	function formatCreatedAt(createdAt: number) {
		return new Date(createdAt).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

{#if item.kind === 'release'}
	<div class="mx-auto w-full max-w-xl">
		<article class="rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
			<div class="mb-1.5 flex items-center justify-between gap-2">
				<h2 class="text-base font-semibold tracking-tight text-foreground">{item.title}</h2>
				{#if unread}
					<span
						class="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
					>
						New
					</span>
				{/if}
			</div>
			<p class="text-sm leading-6 break-words whitespace-pre-wrap text-foreground/90">
				{item.body}
			</p>
			<p class="mt-3 text-[11px] text-muted-foreground">{formatCreatedAt(item.createdAt)}</p>
		</article>
	</div>
{:else}
	<div
		class="mx-auto flex w-full max-w-xl flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-muted/30 px-5 py-4 text-center"
	>
		<div class="flex items-center gap-2 text-muted-foreground">
			<Heart class="size-4" />
			<span class="text-[11px] font-semibold tracking-[0.18em] uppercase">Support Cordn</span>
		</div>
		<p class="text-sm text-muted-foreground">{item.body}</p>
		<Button size="sm" variant="outline" onclick={onDonate}>Donate</Button>
	</div>
{/if}
