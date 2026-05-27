<script lang="ts">
	import { resolve } from '$app/paths';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ChatPubkeyMultiSelect from '$lib/components/chat/ChatPubkeyMultiSelect.svelte';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as InputGroup from '$lib/components/ui/input-group';
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
		removeGroupMemberAction,
		updateGroupMetadataAction
	} from '$lib/services/chatUiActions.svelte';
	import { normalizePubKey } from '$lib/utils';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Save from '@lucide/svelte/icons/save';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
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
	const memberAdminOptions = $derived.by(() =>
		members.map((member) => ({
			pubkey: normalizePubKey(member.stablePubkey),
			description: `Leaf index ${member.leafIndex}`
		}))
	);
	let metadataName = $state('');
	let metadataDescription = $state('');
	let metadataIcon = $state('');
	let metadataImageUrl = $state('');
	let metadataAdminPubkeys = $state<string[]>([]);
	let metadataFormOpen = $state(false);
	let lastMetadataSignature = $state('');
	let showDeleteGroupDialog = $state(false);
	let showGroupId = $state(false);

	function syncMetadataForm() {
		if (!group) return;
		metadataName = group.metadata?.name ?? '';
		metadataDescription = group.metadata?.description ?? '';
		metadataIcon = group.metadata?.icon ?? '';
		metadataImageUrl = group.metadata?.imageUrl ?? '';
		metadataAdminPubkeys = (group.metadata?.adminPubkeys ?? []).map((pubkey) =>
			normalizePubKey(pubkey)
		);
	}

	$effect(() => {
		if (!group) return;
		const signature = JSON.stringify({
			id: group.id,
			name: group.metadata?.name ?? '',
			description: group.metadata?.description ?? '',
			icon: group.metadata?.icon ?? '',
			imageUrl: group.metadata?.imageUrl ?? '',
			adminPubkeys: group.metadata?.adminPubkeys ?? []
		});
		if (lastMetadataSignature === signature) return;
		lastMetadataSignature = signature;
		syncMetadataForm();
	});

	const metadataDirty = $derived.by(() => {
		if (!group) return false;
		const currentAdminPubkeys = (group.metadata?.adminPubkeys ?? []).map((pubkey) =>
			normalizePubKey(pubkey)
		);
		return (
			metadataName.trim() !== (group.metadata?.name ?? '') ||
			metadataDescription.trim() !== (group.metadata?.description ?? '') ||
			metadataIcon.trim() !== (group.metadata?.icon ?? '') ||
			metadataImageUrl.trim() !== (group.metadata?.imageUrl ?? '') ||
			JSON.stringify(metadataAdminPubkeys) !== JSON.stringify(currentAdminPubkeys)
		);
	});

	async function removeMember(pubkey: string) {
		if (!group) return;
		await removeGroupMemberAction(group.id, pubkey);
	}

	async function deleteGroup() {
		if (!group) return;
		showDeleteGroupDialog = false;
		await deleteGroupAction(group.id);
	}

	async function saveMetadata(event: Event) {
		event.preventDefault();
		if (!group) return;
		const saved = await updateGroupMetadataAction(group.id, {
			name: metadataName.trim(),
			description: metadataDescription.trim() || undefined,
			icon: metadataIcon.trim() || undefined,
			imageUrl: metadataImageUrl.trim() || undefined,
			adminPubkeys: metadataAdminPubkeys
		});
		if (saved) {
			metadataFormOpen = false;
		}
	}

	function cancelMetadataEdit() {
		syncMetadataForm();
		chatGroupInfoActionsStore.error = '';
		metadataFormOpen = false;
	}
</script>

<svelte:head>
	<title>{group?.metadata?.name || 'Group info'} | Cordn</title>
	<meta name="description" content="Inspect Cordn group metadata and membership." />
</svelte:head>

{#if group}
	<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
		<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
			<div class="flex items-start justify-between gap-4">
				<div class="flex min-w-0 items-center gap-3">
					<ChatMobileSidebarButton />
					<Avatar class="h-12 w-12 border border-border bg-card">
						{#if group.metadata?.imageUrl}
							<AvatarImage
								src={group.metadata.imageUrl}
								alt={group.metadata?.name || group.id}
								class="object-cover"
							/>
						{/if}
						<AvatarFallback class="bg-card text-lg">
							{#if group.metadata?.icon}
								{group.metadata.icon}
							{:else}
								<img
									src="/cordn-logo-black.svg"
									alt="Cordn"
									class="h-6 w-6 object-contain dark:hidden"
								/>
								<img
									src="/cordn-logo.svg"
									alt="Cordn"
									class="hidden h-6 w-6 object-contain dark:block"
								/>
							{/if}
						</AvatarFallback>
					</Avatar>
					<div class="min-w-0">
						<p class="text-xs tracking-[0.2em] text-muted-foreground uppercase">Group details</p>
						<h1 class="truncate text-xl font-semibold tracking-tight">
							{group.metadata?.name || 'Unnamed chat'}
						</h1>
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
								alt={group.metadata?.name || group.id}
								class="max-h-64 w-full rounded-2xl border border-border object-cover"
							/>
						{/if}

						{#if group.metadata?.description}
							<div class="rounded-2xl border border-border p-4">
								<p class="text-xs tracking-wide text-muted-foreground uppercase">Description</p>
								<p class="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">
									{group.metadata.description}
								</p>
							</div>
						{/if}

						<div class="grid gap-4 md:grid-cols-2">
							<div class="rounded-2xl border border-border p-4">
								<div class="flex items-center justify-between gap-3">
									<p class="text-xs tracking-wide text-muted-foreground uppercase">Group id</p>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										class="h-8 px-2"
										onclick={() => (showGroupId = !showGroupId)}
									>
										{#if showGroupId}
											<EyeOff class="mr-1 size-4" />Hide
										{:else}
											<Eye class="mr-1 size-4" />Show
										{/if}
									</Button>
								</div>
								<p class="mt-2 font-mono text-xs break-all text-muted-foreground">
									{showGroupId ? group.id : 'Hidden until revealed'}
								</p>
							</div>
							<div class="rounded-2xl border border-border p-4">
								<p class="text-xs tracking-wide text-muted-foreground uppercase">Coordinator</p>
								<p class="mt-2 font-mono text-xs break-all">{group.coordinatorKey}</p>
							</div>
							<div class="rounded-2xl border border-border p-4">
								<p class="text-xs tracking-wide text-muted-foreground uppercase">Created</p>
								<p class="mt-2 text-sm">{new Date(group.createdAt).toLocaleString()}</p>
							</div>
						</div>

						{#if canManageMembers}
							<Collapsible.Root bind:open={metadataFormOpen}>
								<Collapsible.Trigger>
									{#snippet child({ props })}
										<Button {...props} type="button" variant="outline" class="gap-2 self-start">
											<Pencil class="size-4" />
											{metadataFormOpen ? 'Hide editor' : 'Edit metadata'}
											<ChevronDown
												class={`size-4 transition-transform ${metadataFormOpen ? 'rotate-180' : ''}`}
											/>
										</Button>
									{/snippet}
								</Collapsible.Trigger>

								<Collapsible.Content>
									<form class="space-y-4 border-t border-border p-4" onsubmit={saveMetadata}>
										<InputGroup.Root>
											<InputGroup.Input bind:value={metadataName} placeholder="Group name" />
											<InputGroup.Addon>
												<InputGroup.Text>Name</InputGroup.Text>
											</InputGroup.Addon>
										</InputGroup.Root>

										<InputGroup.Root>
											<InputGroup.Input bind:value={metadataIcon} placeholder="🪢" />
											<InputGroup.Addon>
												<InputGroup.Text>Icon</InputGroup.Text>
											</InputGroup.Addon>
										</InputGroup.Root>

										<InputGroup.Root>
											<InputGroup.Input
												bind:value={metadataImageUrl}
												placeholder="https://example.com/group.png"
											/>
											<InputGroup.Addon>
												<InputGroup.Text>Image</InputGroup.Text>
											</InputGroup.Addon>
										</InputGroup.Root>

										<InputGroup.Root>
											<InputGroup.Textarea
												bind:value={metadataDescription}
												placeholder="Describe the group"
												class="min-h-28"
											/>
											<InputGroup.Addon align="block-start">
												<InputGroup.Text>Description</InputGroup.Text>
											</InputGroup.Addon>
										</InputGroup.Root>

										<ChatPubkeyMultiSelect
											label="Admins"
											helperText="Choose admins from the current group members. Leave empty to keep the group egalitarian."
											placeholder="Search group members…"
											emptyLabel="No eligible members available."
											options={memberAdminOptions}
											bind:selectedPubkeys={metadataAdminPubkeys}
											showRawPubkey={true}
										/>

										<div
											class="flex flex-col gap-3 rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
										>
											<p>
												Changes are committed to the MLS group and become visible to participants
												after sync.
											</p>
											<div class="flex gap-2 self-end sm:self-auto">
												<Button type="button" variant="ghost" onclick={cancelMetadataEdit}>
													Cancel
												</Button>
												<Button
													type="submit"
													disabled={chatGroupInfoActionsStore.metadataSubmitting || !metadataDirty}
												>
													<Save class="mr-2 size-4" />
													{chatGroupInfoActionsStore.metadataSubmitting
														? 'Saving…'
														: 'Save metadata'}
												</Button>
											</div>
										</div>
									</form>
								</Collapsible.Content>
							</Collapsible.Root>
						{/if}
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
							onclick={() => (showDeleteGroupDialog = true)}
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

		<Dialog.Root bind:open={showDeleteGroupDialog}>
			<Dialog.Content class="sm:max-w-[425px]">
				<Dialog.Header>
					<Dialog.Title>Delete local group?</Dialog.Title>
					<Dialog.Description>
						This only removes the saved copy of this group from this browser. Messages and group
						membership on other devices or coordinators are not affected.
					</Dialog.Description>
				</Dialog.Header>
				<Dialog.Footer>
					<Button
						variant="outline"
						onclick={() => (showDeleteGroupDialog = false)}
						disabled={chatGroupInfoActionsStore.deleteSubmitting}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onclick={deleteGroup}
						disabled={chatGroupInfoActionsStore.deleteSubmitting}
					>
						{chatGroupInfoActionsStore.deleteSubmitting ? 'Deleting…' : 'Delete local group'}
					</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>
	</div>
{/if}
