<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import Heart from '@lucide/svelte/icons/heart';
	import Zap from '@lucide/svelte/icons/zap';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { msatsToSats } from '$lib/services/donations/amounts';
	import { loadSupporters, supporters } from '$lib/services/donations/donationSupporters.svelte';
	import type { DonationConfig } from '$lib/news/feedItems';

	let { config }: { config: DonationConfig } = $props();

	// Collapsed by default; the pubkey list (and its profile fetches) only
	// mounts when expanded, so profiles are lazy-loaded on demand.
	let expanded = $state(false);

	// Per-supporter comment expansion: long donation messages are truncated
	// by default; clicking the message toggles it to full (wrapped) text.
	let expandedComments = $state<Record<string, boolean>>({});

	function toggleComment(pubkey: string) {
		expandedComments[pubkey] = !expandedComments[pubkey];
	}

	// Idempotent: a repeat call for the same recipient is a no-op, so reopening
	// the page renders from the persistent store with no network calls. The
	// subscription is kept warm for the app lifetime — do not tear it down here.
	$effect(() => {
		loadSupporters(config.lnAddress, config.recipientPubkey);
	});

	const status = $derived(supporters.state);
	const count = $derived(status.kind === 'loaded' ? status.supporters.length : 0);
	const totalSats = $derived(
		status.kind === 'loaded'
			? msatsToSats(status.supporters.reduce((sum, s) => sum + s.msats, 0))
			: 0
	);

	function fmtSats(msats: number): string {
		return msatsToSats(msats).toLocaleString();
	}
</script>

<div class="border-t border-border bg-background">
	<div class="mx-auto w-full max-w-2xl px-4 sm:px-6">
		<button
			type="button"
			class="flex w-full items-center gap-3 py-3 text-left"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
			aria-label={expanded ? 'Collapse supporters' : 'Expand supporters'}
		>
			<Heart class="size-4 shrink-0 text-muted-foreground" />
			<span class="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
				Supporters
			</span>
			<span class="ml-auto flex items-center gap-2">
				{#if status.kind === 'loading'}
					<LoaderCircle class="size-3.5 animate-spin text-muted-foreground" />
				{:else}
					<span class="text-sm font-medium text-foreground">
						{count} · {totalSats.toLocaleString()} sats
					</span>
				{/if}
				<ChevronUp
					class={`size-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
				/>
			</span>
		</button>

		{#if expanded}
			<div class="pb-3">
				{#if status.kind === 'error'}
					<p class="py-4 text-center text-sm text-muted-foreground">{status.message}</p>
				{:else if status.kind === 'loaded' && status.supporters.length === 0}
					<p class="py-4 text-center text-sm text-muted-foreground">
						Be the first to support Cordn with a Lightning zap.
					</p>
				{:else if status.kind === 'loaded'}
					<div class="max-h-80 divide-y divide-border overflow-y-auto">
						{#each status.supporters as supporter (supporter.pubkey)}
							<div class="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
								<div class="min-w-0 flex-1">
									<ProfileCard pubkey={supporter.pubkey} mode="compact" showLogout={false} />
									{#if supporter.comment}
										<button
											type="button"
											onclick={() => toggleComment(supporter.pubkey)}
											aria-expanded={expandedComments[supporter.pubkey] ?? false}
											class={`mt-0.5 block w-full cursor-pointer appearance-none border-0 bg-transparent p-0 text-left text-xs text-muted-foreground italic ${
												expandedComments[supporter.pubkey]
													? 'break-words whitespace-pre-wrap'
													: 'truncate'
											}`}
										>
											&ldquo;{supporter.comment}&rdquo;
										</button>
									{/if}
								</div>
								<div class="shrink-0 text-right">
									<span class="text-sm font-semibold">{fmtSats(supporter.msats)} sats</span>
									<span
										class="ml-1.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground"
									>
										<Zap class="size-3" />
										{supporter.zapCount}
									</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
