<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';

	import type { EmojiPack } from '$lib/chat/emoji';
	import EmojiPackCompatibility from '$lib/components/chat/EmojiPackCompatibility.svelte';
	import EmojiPackPreview from '$lib/components/chat/EmojiPackPreview.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Spinner } from '$lib/components/ui/spinner';
	import { emojiListQueryOptions } from '$lib/queries/chatEmojiQueries';
	import {
		EMOJI_PACK_ERRORS,
		addEmojiPackSnapshot,
		importEmojiPacksFromList,
		listEmojiPacks
	} from '$lib/services/chatEmojiPacks.svelte';
	import { packProbeRank } from '$lib/services/emojiPackProbe.svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

	/**
	 * The packs an account publishes in its NIP-51 emoji list (kind 10030).
	 * Settings is an explicit visit, so the list and its sets load on arrival and
	 * are imported, making their shortcodes usable in chat right away.
	 */
	let { pubkey }: { pubkey: string } = $props();

	const listQuery = createQuery(() => emojiListQueryOptions(pubkey));
	const addresses = $derived(listQuery.data ?? []);
	const added = $derived(new Set(listEmojiPacks().map((pack) => pack.coordinate)));

	let loading = $state(true);
	let packs = $state<EmojiPack[]>([]);
	let missing = $state(0);
	let blocked = $state(0);
	let failure = $state('');
	let notice = $state('');
	let resolvedFor = '';

	$effect(() => {
		const signature = addresses.map((address) => address.coordinate).join('\n');
		if (!signature || signature === resolvedFor) return;
		resolvedFor = signature;
		void resolve();
	});

	async function resolve(refresh = false) {
		loading = true;
		blocked = 0;
		failure = '';
		notice = '';
		try {
			// Importing is the point: the account's own list keeps working without a click.
			const result = await importEmojiPacksFromList(addresses, pubkey, { refresh });
			// Unsendable packs last, exactly as the rest of the page lists them.
			packs = [...result.packs].sort((a, b) => packProbeRank(a) - packProbeRank(b));
			missing = result.missing;
			blocked = result.blocked;
		} catch {
			failure = 'Could not load these packs from the relays.';
		} finally {
			loading = false;
		}
	}

	function add(pack: EmojiPack) {
		const result = addEmojiPackSnapshot(pack);
		if ('error' in result) {
			failure = EMOJI_PACK_ERRORS[result.error];
			return;
		}
		failure = '';
		notice = `Added ${result.pack.title}.`;
	}
</script>

{#if addresses.length > 0}
	<Card.Root>
		<details class="group">
			<summary
				class="flex cursor-pointer list-none items-start justify-between gap-3 px-6 [&::-webkit-details-marker]:hidden"
			>
				<div class="min-w-0 space-y-1.5">
					<p class="text-base font-medium">Published packs</p>
					<p class="text-sm text-muted-foreground">
						{addresses.length} pack{addresses.length === 1 ? '' : 's'} in your Nostr emoji list.
						{#if loading}
							Looking for them…
						{:else if blocked > 0}
							{blocked} could not be added automatically.
						{:else if missing > 0}
							{missing} could not be found on the relays.
						{:else}
							Added to your packs automatically.
						{/if}
					</p>
				</div>
				<ChevronDown
					class="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
				/>
			</summary>
			<div class="space-y-3 px-6 pt-4">
				{#if loading}
					<div class="flex items-center gap-2 py-2 text-sm text-muted-foreground">
						<Spinner class="size-4" />
						Looking for your packs…
					</div>
				{:else if packs.length === 0}
					<div class="space-y-2">
						<p class="text-sm text-muted-foreground">
							{failure || 'These packs could not be found on the relays.'}
						</p>
						<Button type="button" variant="outline" size="sm" onclick={() => void resolve(true)}>
							Try again
						</Button>
					</div>
				{:else}
					<div class="space-y-2">
						{#each packs as pack (pack.coordinate)}
							<div class="space-y-2 rounded-xl border border-border p-3">
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<p class="truncate text-sm font-medium">{pack.title}</p>
										<p class="text-xs text-muted-foreground">{pack.emoji.length} emoji</p>
										<EmojiPackCompatibility {pack} />
									</div>
									{#if added.has(pack.coordinate)}
										<Button type="button" variant="outline" size="sm" disabled>Added</Button>
									{:else}
										<Button type="button" variant="outline" size="sm" onclick={() => add(pack)}>
											Add
										</Button>
									{/if}
								</div>
								<EmojiPackPreview {pack} limit={4} gateAutoLoad={false} />
							</div>
						{/each}
					</div>
					{#if missing > 0}
						<div class="flex items-center justify-between gap-2">
							<p class="text-xs text-muted-foreground">
								{missing} pack{missing === 1 ? '' : 's'} could not be found.
							</p>
							<Button type="button" variant="outline" size="sm" onclick={() => void resolve(true)}>
								Try again
							</Button>
						</div>
					{/if}
					{#if notice}<p class="text-sm text-muted-foreground">{notice}</p>{/if}
					{#if failure}<p class="text-sm text-destructive">{failure}</p>{/if}
				{/if}
			</div>
		</details>
	</Card.Root>
{/if}
