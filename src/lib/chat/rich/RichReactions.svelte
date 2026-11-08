<script lang="ts">
	import * as Collapsible from '$lib/components/ui/collapsible';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import CustomEmoji from '$lib/components/chat/CustomEmoji.svelte';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { manager } from '$lib/services/accountManager.svelte';
	import type { AnnotationIndex } from '$lib/chat/references';
	import { normalizePubKey } from '$lib/utils';

	/**
	 * Collapsible reactions section for the rich views (detail sidebar and
	 * /chat/[id]/e/[eventId]): summary chips plus the per-emoji reactor list —
	 * the stream's chips carry no names. Shared by every rich body (text,
	 * polls, …) so reactions stay inspectable no matter the message kind.
	 */
	let { index, messageId }: { index: AnnotationIndex; messageId: string } = $props();

	const activePubkey = $derived.by(() => {
		const pubkey = manager.getActive()?.pubkey;
		return pubkey ? normalizePubKey(pubkey) : '';
	});

	const reactions = $derived.by(() => {
		const byEmoji = index.reactionMap.get(messageId);
		if (!byEmoji) return [];
		return Array.from(byEmoji.values()).map((entry) => ({
			emoji: entry.emoji,
			count: entry.reactors.size,
			reactedByMe: activePubkey ? entry.reactors.has(activePubkey) : false,
			reactors: Array.from(entry.reactors.keys()),
			display: entry.display,
			mediaKeyBase64: entry.mediaKeyBase64
		}));
	});
	const reactionTotal = $derived(reactions.reduce((total, reaction) => total + reaction.count, 0));

	let open = $state(false);
</script>

{#if reactions.length}
	<section class="space-y-2">
		<Collapsible.Root bind:open>
			<Collapsible.Trigger
				class="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-1 text-left"
			>
				<span class="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
					Reactions · {reactionTotal}
				</span>
				<ChevronRight
					class={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
				/>
			</Collapsible.Trigger>

			<div class="flex flex-wrap gap-2 px-1 pt-1">
				{#each reactions as reaction (`${messageId}:rxn:${reaction.emoji}`)}
					<span
						class={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${reaction.reactedByMe ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border bg-muted/40 text-muted-foreground'}`}
					>
						{#if reaction.display}
							<CustomEmoji
								display={reaction.display}
								mediaKeyBase64={reaction.mediaKeyBase64}
								sizeClass="size-4"
							/>
						{:else}
							<span>{reaction.emoji}</span>
						{/if}
						<span>{reaction.count}</span>
					</span>
				{/each}
			</div>

			<Collapsible.Content>
				<div class="mt-2 space-y-3 px-1">
					{#each reactions as reaction (`${messageId}:rxn-detail:${reaction.emoji}`)}
						<div class="rounded-2xl border p-3">
							<div class="mb-2 flex items-center gap-2">
								{#if reaction.display}
									<CustomEmoji
										display={reaction.display}
										mediaKeyBase64={reaction.mediaKeyBase64}
										sizeClass="size-6"
									/>
								{:else}
									<span class="text-lg">{reaction.emoji}</span>
								{/if}
								<span class="font-medium">
									{reaction.count} reaction{reaction.count === 1 ? '' : 's'}
								</span>
							</div>
							<div class="flex flex-col gap-2">
								{#each reaction.reactors as reactor (`${messageId}:rxn-detail:${reaction.emoji}:${reactor}`)}
									<ProfileCard pubkey={reactor} mode="inline" showInlineAvatar={true} />
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	</section>
{/if}
