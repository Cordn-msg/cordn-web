<script lang="ts">
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		fetchChatGroupMessages,
		inviteChatGroupMember,
		listCoordinatorAvailableKeyPackages,
		type CoordinatorAvailableKeyPackage
	} from '$lib/services/chatGroups.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import Download from '@lucide/svelte/icons/download';
	import UserPlus from '@lucide/svelte/icons/user-plus';

	let {
		groupId,
		title = 'Cordn',
		subtitle = 'Coordinator-assisted messaging'
	}: {
		groupId?: string;
		title?: string;
		subtitle?: string;
	} = $props();

	let inviteOpen = $state(false);
	let inviteLoading = $state(false);
	let inviteSubmitting = $state(false);
	let inviteError = $state('');
	let fetchLoading = $state(false);
	let availableKeyPackages = $state<CoordinatorAvailableKeyPackage[]>([]);

	async function fetchMessages() {
		if (!groupId || fetchLoading) return;
		fetchLoading = true;
		inviteError = '';
		try {
			await fetchChatGroupMessages(groupId);
		} catch (error) {
			inviteError = error instanceof Error ? error.message : 'Failed to fetch messages';
		} finally {
			fetchLoading = false;
		}
	}

	async function refreshAvailableKeyPackages() {
		if (!$activeAccount || !groupId) return;
		inviteLoading = true;
		inviteError = '';
		try {
			availableKeyPackages = await listCoordinatorAvailableKeyPackages(groupId);
		} catch (error) {
			inviteError =
				error instanceof Error ? error.message : 'Failed to load available key packages';
		} finally {
			inviteLoading = false;
		}
	}

	async function inviteMember(identifier: string) {
		if (!groupId || inviteSubmitting) return;
		inviteSubmitting = true;
		inviteError = '';
		try {
			await inviteChatGroupMember({ groupId, identifier });
			await refreshAvailableKeyPackages();
			inviteOpen = false;
		} catch (error) {
			inviteError = error instanceof Error ? error.message : 'Failed to invite member';
		} finally {
			inviteSubmitting = false;
		}
	}

	function formatKeyPackageLabel(entry: CoordinatorAvailableKeyPackage) {
		return `${entry.stablePubkey.slice(0, 12)}…${entry.stablePubkey.slice(-8)}`;
	}

	$effect(() => {
		if (inviteOpen) {
			void refreshAvailableKeyPackages();
		}
	});
</script>

<header
	class="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
>
	<div class="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
		<div class="flex min-w-0 items-center gap-3">
			<Avatar class="h-10 w-10 border border-border bg-card">
				<AvatarFallback class="bg-card text-base">🪢</AvatarFallback>
			</Avatar>

			<div class="min-w-0">
				<h1 class="truncate text-lg font-semibold tracking-tight">{title}</h1>
				<p class="truncate text-sm text-muted-foreground">{subtitle}</p>
			</div>
		</div>

		{#if groupId}
			<div class="flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="h-10 w-10 rounded-xl"
					disabled={!$activeAccount || fetchLoading}
					aria-label="Fetch messages"
					onclick={fetchMessages}
				>
					<Download class="size-4" />
				</Button>

				<Dialog.Root bind:open={inviteOpen}>
					<Dialog.Trigger class="inline-flex" disabled={!$activeAccount} aria-label="Invite member">
						<Button
							type="button"
							variant="outline"
							size="icon"
							class="h-10 w-10 rounded-xl"
							disabled={!$activeAccount}
							aria-label="Invite member"
						>
							<UserPlus class="size-4" />
						</Button>
					</Dialog.Trigger>
					<Dialog.Content class="sm:max-w-2xl">
						<Dialog.Header>
							<Dialog.Title>Invite member</Dialog.Title>
							<Dialog.Description>
								Consume a coordinator key package and publish a welcome for this group.
							</Dialog.Description>
						</Dialog.Header>

						{#if inviteError}
							<p class="text-sm text-destructive">{inviteError}</p>
						{/if}

						<div class="space-y-3">
							<div class="flex items-center justify-between gap-2">
								<p class="text-sm text-muted-foreground">
									{availableKeyPackages.length} available key package{availableKeyPackages.length ===
									1
										? ''
										: 's'}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onclick={refreshAvailableKeyPackages}
									disabled={inviteLoading || !$activeAccount}
								>
									{inviteLoading ? 'Refreshing…' : 'Refresh'}
								</Button>
							</div>

							<div
								class="max-h-[24rem] space-y-2 overflow-y-auto rounded-xl border border-border p-3"
							>
								{#if !$activeAccount}
									<p class="text-sm text-muted-foreground">Log in to invite members.</p>
								{:else if inviteLoading && availableKeyPackages.length === 0}
									<p class="text-sm text-muted-foreground">Loading available key packages…</p>
								{:else if availableKeyPackages.length === 0}
									<p class="text-sm text-muted-foreground">
										No coordinator key packages available for invitation.
									</p>
								{:else}
									{#each availableKeyPackages as entry (entry.keyPackageRef)}
										<div
											class="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/60 px-4 py-3"
										>
											<div class="min-w-0 space-y-1">
												<p class="truncate font-medium">{formatKeyPackageLabel(entry)}</p>
												<p class="font-mono text-xs break-all text-muted-foreground">
													{entry.keyPackageRef}
												</p>
												<p class="text-xs text-muted-foreground">
													Published {new Date(
														entry.publishedAt
													).toLocaleString()}{entry.isLastResort ? ' · last resort' : ''}
												</p>
											</div>
											<Button
												type="button"
												size="sm"
												onclick={() => inviteMember(entry.keyPackageRef)}
												disabled={inviteSubmitting}
											>
												Invite
											</Button>
										</div>
									{/each}
								{/if}
							</div>
						</div>
					</Dialog.Content>
				</Dialog.Root>
			</div>
		{/if}
	</div>
</header>
