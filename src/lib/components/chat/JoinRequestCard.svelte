<script lang="ts">
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import {
		getProfileDisplayName,
		getChatGroupDisplayTitle
	} from '$lib/components/chat/chatGroupDisplay';
	import type { ChatGroupProfileHints } from '$lib/components/chat/chatGroupDisplay';
	import type { JoinRequestEntry } from '$lib/services/chatJoinRequests.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getChatGroup, listChatGroupMembers } from '$lib/services/chatGroups.svelte';
	import { normalizePubKey } from '$lib/utils';

	let {
		entry,
		profileHints = {},
		showReject = true,
		showCoordinatorLabel = true,
		coordinatorLabel = '',
		submitting = false,
		onAccept,
		onReject
	}: {
		entry: JoinRequestEntry;
		profileHints: ChatGroupProfileHints;
		showReject?: boolean;
		showCoordinatorLabel?: boolean;
		coordinatorLabel?: string;
		submitting?: boolean;
		onAccept: () => void;
		onReject?: () => void;
	} = $props();

	const group = $derived.by(() => getChatGroup(entry.groupId));

	const groupMemberPubkeys = $derived.by(() =>
		group
			? listChatGroupMembers(group.id)
					.map((member) => normalizePubKey(member.stablePubkey))
					.filter((pubkey): pubkey is string => Boolean(pubkey))
			: []
	);

	// A requester can already occupy a stale leaf in the tree (joined another
	// way, or lost local state). Accept then runs the remove-then-readd
	// reinvite path, so label it honestly and explain the churn.
	const isExistingMember = $derived(
		groupMemberPubkeys.includes(normalizePubKey(entry.requesterStablePubkey))
	);
	const acceptLabel = $derived(isExistingMember ? 'Re-add' : 'Accept');
	const acceptingLabel = $derived(isExistingMember ? 'Re-adding…' : 'Accepting…');

	const groupDisplayName = $derived.by(() => {
		if (!group) return 'group';
		return getChatGroupDisplayTitle({
			group,
			activePubkey: $activeAccount?.pubkey,
			memberPubkeys: groupMemberPubkeys
		});
	});

	function getDisplayName() {
		return getProfileDisplayName(entry.requesterStablePubkey, profileHints);
	}

	function getAvatarFallback() {
		return getDisplayName().slice(0, 1).toUpperCase() || '#';
	}
</script>

<div
	class="overflow-hidden rounded-lg border px-3 py-2.5 {entry.readAt
		? 'border-border bg-background/50'
		: 'border-primary/40 bg-primary/5'}"
>
	<div class="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
		<div class="flex min-w-0 gap-2.5">
			<Avatar class="h-9 w-9 shrink-0 border border-border bg-background">
				<AvatarFallback class="bg-background text-xs font-medium">
					{getAvatarFallback()}
				</AvatarFallback>
			</Avatar>
			<div class="min-w-0 flex-1 space-y-0.5 overflow-hidden">
				<p class="truncate text-sm font-medium sm:whitespace-normal">
					{getDisplayName()}
				</p>
				<p class="line-clamp-2 text-xs wrap-break-word text-muted-foreground">
					Wants to join {groupDisplayName}
				</p>
				{#if isExistingMember}
					<p class="text-[11px] text-amber-600 dark:text-amber-400">
						Already in group — re-add refreshes their access
					</p>
				{/if}
				{#if showCoordinatorLabel && coordinatorLabel}
					<p class="truncate text-[11px] text-muted-foreground">
						{coordinatorLabel}
					</p>
				{/if}
				<p class="text-[11px] text-muted-foreground">
					{new Date(entry.at).toLocaleString()}
				</p>
				{#if entry.acceptedGroupId}
					<p class="text-[11px] text-emerald-600 dark:text-emerald-400">Accepted into group</p>
				{/if}
			</div>
		</div>
		<div class="flex flex-wrap gap-1.5 sm:max-w-[13rem] sm:justify-end">
			{#if !entry.acceptedGroupId}
				<Button type="button" size="sm" class="h-8 px-3" onclick={onAccept} disabled={submitting}>
					{#if submitting}
						<Spinner class="mr-1 size-3" />
					{/if}
					{submitting ? acceptingLabel : acceptLabel}
				</Button>
				{#if showReject && onReject}
					<Button
						type="button"
						variant="destructive"
						size="sm"
						class="h-8 px-3"
						onclick={onReject}
						disabled={submitting}
					>
						{#if submitting}
							<Spinner class="mr-1 size-3" />
						{/if}
						{submitting ? 'Rejecting…' : 'Reject'}
					</Button>
				{/if}
			{/if}
		</div>
	</div>
</div>
