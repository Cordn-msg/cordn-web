<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import JoinRequestCard from './JoinRequestCard.svelte';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getCoordinatorLabel } from '$lib/services/chatCoordinators.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import {
		acceptJoinRequestAction,
		rejectJoinRequestAction,
		refreshJoinRequestsAction
	} from '$lib/services/chatUiActions.svelte';
	import { useJoinRequests } from '$lib/queries/chatJoinRequestQueries';
	import {
		chatJoinRequestsStore,
		isJoinRequestSubmitting,
		listJoinRequests,
		markAllJoinRequestsRead
	} from '$lib/services/chatJoinRequests.svelte';
	import { normalizePubKey } from '$lib/utils';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';

	let {
		maxHeightClass = 'h-[min(26rem,60vh)]',
		emptyClass = 'rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground'
	}: {
		maxHeightClass?: string;
		emptyClass?: string;
	} = $props();

	const joinRequests = $derived.by(() => listJoinRequests());
	const useScrollableList = $derived.by(() => joinRequests.length > 2);
	const joinRequestsQuery = useJoinRequests(() => $activeAccount?.pubkey);

	const requesterProfileHints = useProfileHints(
		() => {
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			return [
				...new Set(
					joinRequests
						.map((entry) => entry.requesterStablePubkey)
						.filter((pubkey) => pubkey && pubkey !== activePubkey)
				)
			];
		},
		{ relays: metadataRelays }
	);

	async function refreshJoinRequests() {
		if (!$activeAccount) return;
		await refreshJoinRequestsAction();
	}

	async function acceptJoinRequest(id: string) {
		if (!$activeAccount) return;
		await acceptJoinRequestAction(id);
	}

	async function rejectJoinRequest(id: string) {
		if (!$activeAccount) return;
		await rejectJoinRequestAction(id);
	}
</script>

<div class="space-y-3">
	<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
		<h3>Join requests</h3>
		<div class="flex flex-wrap gap-2">
			<Button type="button" variant="outline" size="sm" onclick={markAllJoinRequestsRead}>
				Mark all as read
			</Button>
			<Button
				type="button"
				size="sm"
				onclick={refreshJoinRequests}
				disabled={chatJoinRequestsStore.loading || !$activeAccount}
			>
				{#if chatJoinRequestsStore.loading}
					<Spinner class="mr-1 size-3" />
				{/if}
				{chatJoinRequestsStore.loading ? 'Refreshing…' : 'Refresh'}
			</Button>
		</div>
	</div>

	{#if chatJoinRequestsStore.error}
		<p class="text-sm text-destructive">{chatJoinRequestsStore.error}</p>
	{:else if joinRequestsQuery.error}
		<p class="text-sm text-destructive">
			{joinRequestsQuery.error instanceof Error
				? joinRequestsQuery.error.message
				: 'Failed to fetch join requests'}
		</p>
	{/if}

	{#if !$activeAccount}
		<div class={emptyClass}>Log in to see join requests.</div>
	{:else if joinRequests.length === 0}
		<div class={emptyClass}>No join requests yet.</div>
	{:else if useScrollableList}
		<ScrollArea.Root class={`${maxHeightClass} rounded-xl border border-border`}>
			<div class="space-y-2 p-2.5">
				{#each joinRequests as entry (entry.id)}
					<JoinRequestCard
						{entry}
						profileHints={requesterProfileHints}
						coordinatorLabel={getCoordinatorLabel(entry.coordinatorKey)}
						submitting={isJoinRequestSubmitting(entry.id)}
						onAccept={() => acceptJoinRequest(entry.id)}
						onReject={() => rejectJoinRequest(entry.id)}
					/>
				{/each}
			</div>
			<ScrollArea.Scrollbar orientation="vertical" />
		</ScrollArea.Root>
	{:else}
		<div class="space-y-2">
			{#each joinRequests as entry (entry.id)}
				<JoinRequestCard
					{entry}
					profileHints={requesterProfileHints}
					coordinatorLabel={getCoordinatorLabel(entry.coordinatorKey)}
					submitting={isJoinRequestSubmitting(entry.id)}
					onAccept={() => acceptJoinRequest(entry.id)}
					onReject={() => rejectJoinRequest(entry.id)}
				/>
			{/each}
		</div>
	{/if}
</div>
