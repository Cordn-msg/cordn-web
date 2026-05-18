<script lang="ts">
	import { resolve } from '$app/paths';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { isGroupAdmin } from '$lib/services/chatAdminPolicy';
	import {
		getChatGroup,
		isChatGroupRemoved,
		listChatGroupMembers,
		listChatGroups
	} from '$lib/services/chatGroups.svelte';
	import {
		chatGroupInfoActionsStore,
		deleteGroupAction,
		removeGroupMemberAction
	} from '$lib/services/chatUiActions.svelte';
	import { normalizePubKey } from '$lib/utils';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Crown from '@lucide/svelte/icons/crown';
	import Shield from '@lucide/svelte/icons/shield';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import UserRoundX from '@lucide/svelte/icons/user-round-x';

	let { params } = $props();

	const group = $derived.by(() => getChatGroup(params.id) ?? listChatGroups()[0]);
	const members = $derived.by(() => (group ? listChatGroupMembers(group.id) : []));
	const canManageMembers = $derived.by(() => {
		if (!$activeAccount || !group) return false;
		return isGroupAdmin({ metadata: group.metadata, stablePubkey: $activeAccount.pubkey });
	});
	const isRemoved = $derived.by(() => isChatGroupRemoved(group));
	const adminPubkeys = $derived.by(() =>
		(group?.metadata?.adminPubkeys ?? []).map((pubkey) => normalizePubKey(pubkey))
	);

	async function removeMember(pubkey: string) {
		if (!group) return;
		await removeGroupMemberAction(group.id, pubkey);
	}

	async function deleteGroup() {
		if (!group) return;
		await deleteGroupAction(group.id);
	}
</script>

<svelte:head>
	<title>{group?.metadata?.name || group?.alias || 'Group info'} | Cordn</title>
	<meta name="description" content="Inspect Cordn group metadata and membership." />
</svelte:head>

{#if group}
	<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
		<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
			<div class="flex items-start justify-between gap-4">
				<div class="flex min-w-0 items-center gap-3">
					<Avatar class="h-12 w-12 border border-border bg-card">
						<AvatarFallback class="bg-card text-lg">
							{group.metadata?.icon || '🪢'}
						</AvatarFallback>
					</Avatar>
					<div class="min-w-0">
						<p class="text-xs tracking-[0.2em] text-muted-foreground uppercase">Group details</p>
						<h1 class="truncate text-xl font-semibold tracking-tight">
							{group.metadata?.name || group.alias}
						</h1>
						<p class="text-sm text-muted-foreground">
							{group.metadata?.description || 'Coordinator-assisted messaging'}
						</p>
					</div>
				</div>

				<Button href={resolve('/chat/[id]', { id: group.id })} variant="outline">
					<ArrowLeft class="mr-2 size-4" />
					Back to chat
				</Button>
			</div>
		</header>

		<ScrollArea.Root class="min-h-0 flex-1">
			<div class="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
				{#if isRemoved}
					<div
						class="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-sm text-destructive"
					>
						You were removed from this group. Sending and live watching are disabled. Deleting the
						local group below is recommended.
					</div>
				{/if}

				<Card.Root>
					<Card.Header>
						<Card.Title>Metadata</Card.Title>
						<Card.Description>Visible group properties carried in MLS metadata.</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-6">
						{#if group.metadata?.imageUrl}
							<img
								src={group.metadata.imageUrl}
								alt={group.metadata?.name || group.alias}
								class="max-h-64 w-full rounded-2xl border border-border object-cover"
							/>
						{/if}

						<div class="grid gap-4 md:grid-cols-2">
							<div class="rounded-2xl border border-border p-4">
								<p class="text-xs tracking-wide text-muted-foreground uppercase">Group id</p>
								<p class="mt-2 font-mono text-xs break-all">{group.id}</p>
							</div>
							<div class="rounded-2xl border border-border p-4">
								<p class="text-xs tracking-wide text-muted-foreground uppercase">Coordinator</p>
								<p class="mt-2 font-mono text-xs break-all">{group.coordinatorKey}</p>
							</div>
							<div class="rounded-2xl border border-border p-4">
								<p class="text-xs tracking-wide text-muted-foreground uppercase">Alias</p>
								<p class="mt-2 text-sm">{group.alias}</p>
							</div>
							<div class="rounded-2xl border border-border p-4">
								<p class="text-xs tracking-wide text-muted-foreground uppercase">Created</p>
								<p class="mt-2 text-sm">{new Date(group.createdAt).toLocaleString()}</p>
							</div>
						</div>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Local actions</Card.Title>
						<Card.Description>Device-only cleanup actions for this saved group.</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-4">
						<p class="text-sm text-muted-foreground">
							{isRemoved
								? 'This group is no longer active for your account. Delete the local copy to clean up the app state.'
								: 'Deleting here only removes the local saved copy from this browser.'}
						</p>
						<Button
							type="button"
							variant="destructive"
							onclick={deleteGroup}
							disabled={chatGroupInfoActionsStore.deleteSubmitting}
						>
							<Trash2 class="mr-2 size-4" />
							{chatGroupInfoActionsStore.deleteSubmitting ? 'Deleting…' : 'Delete local group'}
						</Button>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Admins</Card.Title>
						<Card.Description>
							Configured admin identities. Empty means the group is egalitarian.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						{#if adminPubkeys.length === 0}
							<div
								class="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground"
							>
								This group is egalitarian. Every current member can perform admin actions.
							</div>
						{:else}
							<div class="space-y-3">
								{#each adminPubkeys as pubkey (pubkey)}
									<div class="flex items-center gap-3 rounded-2xl border border-border p-4">
										<div
											class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card"
										>
											<Crown class="size-4" />
										</div>
										<div class="min-w-0 flex-1">
											<ProfileCard {pubkey} />
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Participants</Card.Title>
						<Card.Description>
							Current MLS membership with local admin context and removal controls.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-4">
						{#if chatGroupInfoActionsStore.error}
							<p class="text-sm text-destructive">{chatGroupInfoActionsStore.error}</p>
						{/if}

						<div class="space-y-3">
							{#each members as member (member.stablePubkey)}
								<div
									class="flex flex-col gap-3 rounded-2xl border border-border p-4 md:flex-row md:items-center md:justify-between"
								>
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											<div class="min-w-0 flex-1">
												<ProfileCard pubkey={member.stablePubkey} />
											</div>
											{#if member.isAdmin}
												<span
													class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground"
												>
													<Shield class="size-3" /> Admin
												</span>
											{/if}
											{#if member.isSelf}
												<span
													class="inline-flex rounded-full border border-border px-2 py-1 text-xs text-muted-foreground"
												>
													You
												</span>
											{/if}
										</div>
										<p class="mt-2 text-xs text-muted-foreground">Leaf index {member.leafIndex}</p>
										<p class="mt-1 font-mono text-xs break-all text-muted-foreground">
											{member.stablePubkey}
										</p>
									</div>

									{#if canManageMembers && !member.isSelf}
										<Button
											type="button"
											variant="outline"
											onclick={() => removeMember(member.stablePubkey)}
											disabled={chatGroupInfoActionsStore.removeSubmitting === member.stablePubkey}
										>
											<UserRoundX class="mr-2 size-4" />
											{chatGroupInfoActionsStore.removeSubmitting === member.stablePubkey
												? 'Removing…'
												: 'Remove'}
										</Button>
									{/if}
								</div>
							{/each}
						</div>

						{#if !canManageMembers}
							<p class="text-sm text-muted-foreground">
								Only configured admins can remove members from restricted groups.
							</p>
						{/if}
					</Card.Content>
				</Card.Root>
			</div>
		</ScrollArea.Root>
	</div>
{/if}
