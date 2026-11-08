<script lang="ts">
	import BarChart3 from '@lucide/svelte/icons/bar-chart-3';

	import { buildPollTally, getMessagePollDefinition, type PollOptionResult } from '$lib/chat/polls';
	import { buildAnnotationIndex } from '$lib/chat/references';
	import MessageParts from '$lib/chat/inline/MessageParts.svelte';
	import type { RichBodyProps } from '$lib/chat/registry';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { listChatGroupMessages } from '$lib/services/chatGroups.svelte';
	import { pollNow, retainPollNow } from '$lib/chat/pollNow.svelte';
	import { manager } from '$lib/services/accountManager.svelte';
	import { formatUnixTimestamp, normalizePubKey } from '$lib/utils';
	import RichReactions from './RichReactions.svelte';

	/**
	 * Full-fidelity poll view (kind 1068) shared by the detail sidebar and
	 * /chat/[id]/e/[eventId] — one presentational component, two containers
	 * (README § Rich context). Read-only on day 1: voting stays in the stream
	 * row's poll card. Self-queries the group's messages, so live vote updates
	 * flow in through the same derived.
	 */
	let { groupId, eventId }: RichBodyProps = $props();

	const activePubkey = $derived.by(() => {
		const pubkey = manager.getActive()?.pubkey;
		return pubkey ? normalizePubKey(pubkey) : '';
	});

	let now = $derived(pollNow());
	const storedMessages = $derived(listChatGroupMessages(groupId));
	// Reactions ride the same annotation index DefaultRich uses — a poll's
	// reactions fold onto its event id exactly like a text message's.
	const annotationIndex = $derived(buildAnnotationIndex(storedMessages));
	const tally = $derived(buildPollTally(storedMessages, eventId, activePubkey, now));
	const pollMessage = $derived(storedMessages.find((message) => message.id === eventId));
	const definition = $derived(
		tally?.definition ??
			(pollMessage
				? getMessagePollDefinition(pollMessage.kind, pollMessage.content, pollMessage.tags)
				: null)
	);

	$effect(() => {
		if (definition?.endsAt == null) return;
		return retainPollNow();
	});

	const open = $derived(tally?.open ?? true);
	const participants = $derived(tally?.participants ?? 0);
	const options = $derived<PollOptionResult[]>(
		tally?.options ?? definition?.options.map((option) => ({ ...option, votes: 0 })) ?? []
	);
</script>

{#if !definition}
	<div class="p-6 text-sm text-muted-foreground italic">Unsupported poll</div>
{:else}
	<div class="flex flex-col gap-4 p-4">
		<div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
			<BarChart3 class="size-3.5" />
			<span
				>Poll · {definition.pollType === 'multiplechoice'
					? 'multiple options'
					: 'single choice'}</span
			>
			{#if !open}
				<span class="rounded-full border border-border px-1.5 py-px text-[10px] uppercase"
					>Closed</span
				>
			{/if}
		</div>

		<div>
			<p class="text-base font-semibold break-words whitespace-pre-wrap">
				<!-- Same lane as DefaultRich's body; the auto-load gate lives in
					InlineMediaUrl, not in the callers. -->
				<MessageParts
					messageId={eventId}
					text={definition.question}
					tags={pollMessage?.tags}
					mediaKeyBase64={pollMessage?.mediaKeyBase64}
				/>
			</p>
			<p class="mt-1 text-xs text-muted-foreground">
				{#if definition.endsAt !== null}
					{open ? 'Ends' : 'Ended'} {formatUnixTimestamp(definition.endsAt * 1000, true, true)}
				{:else}
					No end date
				{/if}
			</p>
		</div>

		<div class="flex flex-col gap-2">
			{#each options as option (option.id)}
				{@const share = participants > 0 ? option.votes / participants : 0}
				{@const voters = tally?.votes.filter((vote) => vote.optionIds.includes(option.id)) ?? []}
				<div class="rounded-xl border border-border/70 bg-background/40 px-3 py-2">
					<div class="flex items-center justify-between gap-2 text-sm">
						<span class="min-w-0 truncate">{option.label}</span>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{option.votes} · {Math.round(share * 100)}%
						</span>
					</div>
					<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted/60">
						<div
							class="h-full rounded-full bg-primary/70"
							style={`width: ${Math.round(share * 100)}%`}
						></div>
					</div>
					<!-- Distribution view: the pick is the headline, voters are full-size
					     name chips (multi-choice voters appear under each of their picks). -->
					{#if voters.length > 0}
						<div class="mt-2 flex flex-wrap gap-1.5">
							{#each voters as vote (vote.voter)}
								<span
									class="inline-flex min-w-0 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-2 py-1"
									title={`Voted ${formatUnixTimestamp(vote.votedAt, true, true)}`}
								>
									<ProfileCard
										pubkey={vote.voter}
										mode="inline"
										showInlineAvatar={true}
										profileLink={false}
									/>
								</span>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<p class="text-xs text-muted-foreground">
			{participants} participant{participants === 1 ? '' : 's'}
		</p>

		<RichReactions index={annotationIndex} messageId={eventId} />
	</div>
{/if}
