<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import * as Dialog from '$lib/components/ui/dialog';
	import GroupLinkInput from '$lib/components/chat/GroupLinkInput.svelte';
	import AvailableKeyPackageDirectory from '$lib/components/chat/AvailableKeyPackageDirectory.svelte';
	import type { AvailableKeyPackageWithCoordinator } from '$lib/queries/chatKeyPackageQueries';
	import { startChatWithKeyPackageAction } from '$lib/services/chatUiActions.svelte';
	import Users from '@lucide/svelte/icons/users';
	import LogIn from '@lucide/svelte/icons/log-in';

	let {
		open = $bindable(false),
		onNavigate = () => {}
	}: {
		open?: boolean;
		onNavigate?: () => void;
	} = $props();

	let startingRef = $state('');
	let error = $state('');

	// bits-ui dialog content unmounts after the close animation, so the directory
	// (and its search state) remounts fresh each time the dialog opens.
	$effect(() => {
		if (open) error = '';
	});

	function handleCreateGroupClick() {
		open = false;
		onNavigate();
	}

	async function startChat(kp: AvailableKeyPackageWithCoordinator) {
		if (!kp.coordinatorKey) {
			error = 'Add a coordinator before starting a chat';
			return;
		}

		try {
			startingRef = kp.kp_ref;
			error = '';
			const groupId = await startChatWithKeyPackageAction(kp);
			open = false;
			onNavigate();
			await goto(resolve('/chat/[id]', { id: groupId }));
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start chat';
		} finally {
			startingRef = '';
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] w-[min(calc(100vw-1.5rem),36rem)] sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>New conversation</Dialog.Title>
			<Dialog.Description>
				Create a new group or start a conversation from an available key package.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-4">
			<a
				href={resolve('/chat/create-group')}
				onclick={handleCreateGroupClick}
				class="flex items-center gap-3 rounded-xl border border-border p-4 transition-colors hover:bg-muted/30"
			>
				<div
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
				>
					<Users class="size-4" />
				</div>
				<div class="min-w-0">
					<p class="text-sm font-medium">Create group</p>
					<p class="text-xs text-muted-foreground">
						Start a new group chat with custom settings and member invites
					</p>
				</div>
			</a>

			<div class="rounded-xl border border-border p-4">
				<div class="flex items-center gap-3">
					<div
						class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
					>
						<LogIn class="size-4" />
					</div>
					<div class="min-w-0">
						<p class="text-sm font-medium">Join group</p>
						<p class="text-xs text-muted-foreground">
							Paste a link or group ID someone shared to open it here
						</p>
					</div>
				</div>
				<div class="mt-3">
					<GroupLinkInput
						onNavigate={() => {
							open = false;
							onNavigate();
						}}
					/>
				</div>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<AvailableKeyPackageDirectory
				onStartChat={startChat}
				{startingRef}
				includeSelf
				showCount
				showCoordinatorFilter
				maxHeightClass="max-h-[32rem]"
				emptyMessage="No public key packages found yet. Add coordinators and publish a key package first."
			/>
		</div>
	</Dialog.Content>
</Dialog.Root>
