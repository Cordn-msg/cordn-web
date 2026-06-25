<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { deleteGroupAction, chatGroupInfoActionsStore } from '$lib/services/chatUiActions.svelte';
	import { listChatGroupMembers, type StoredChatGroup } from '$lib/services/chatGroups.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { normalizePubKey } from '$lib/utils';
	import {
		getChatGroupDisplayTitle,
		type ChatGroupProfileHints
	} from '$lib/components/chat/chatGroupDisplay';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	let {
		group,
		title,
		profileHints
	}: {
		group: StoredChatGroup;
		title?: string;
		profileHints?: ChatGroupProfileHints;
	} = $props();

	let showDeleteDialog = $state(false);
	const submitting = $derived(chatGroupInfoActionsStore.deleteSubmitting);

	// Only resolve hints + recompute the title when the caller didn't pass one,
	// so the common case (rendered inside ChatGroupListItem) doesn't double up.
	const memberPubkeys = $derived.by(() =>
		listChatGroupMembers(group.id)
			.map((member) => normalizePubKey(member.stablePubkey))
			.filter((pubkey): pubkey is string => Boolean(pubkey))
	);
	const fallbackHints = useProfileHints(
		() => {
			if (title || profileHints) return [];
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			return [...new Set(memberPubkeys.filter((pubkey) => pubkey !== activePubkey))];
		},
		{ relays: metadataRelays }
	);
	const resolvedTitle = $derived(
		title ??
			getChatGroupDisplayTitle({
				group,
				activePubkey: $activeAccount?.pubkey,
				profileHints: profileHints ?? fallbackHints,
				memberPubkeys
			})
	);

	async function handleDelete() {
		showDeleteDialog = false;
		await deleteGroupAction(group.id);
	}
</script>

<div class="shrink-0">
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					type="button"
					variant="ghost"
					size="icon-sm"
					class="rounded-lg text-muted-foreground hover:text-foreground"
					aria-label="Group actions"
					title="Group actions"
				>
					<EllipsisVertical class="size-4" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-48">
			<DropdownMenu.Item
				onclick={() => (showDeleteDialog = true)}
				class="gap-2 text-destructive data-[highlighted]:text-destructive"
			>
				<Trash2 class="size-4" />
				<span>Delete local group</span>
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>

<Dialog.Root bind:open={showDeleteDialog}>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>Delete local group?</Dialog.Title>
			<Dialog.Description>
				“{resolvedTitle}” will be removed from this browser. Messages and membership on other
				devices or coordinators are not affected.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (showDeleteDialog = false)} disabled={submitting}>
				Cancel
			</Button>
			<Button variant="destructive" onclick={handleDelete} disabled={submitting}>
				{#if submitting}<Spinner class="mr-2 size-4" />{/if}
				{submitting ? 'Deleting…' : 'Delete local group'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
