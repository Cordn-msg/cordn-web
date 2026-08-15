<script lang="ts">
	import { resolve } from '$app/paths';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { goto } from '$app/navigation';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import GroupLinkInput from '$lib/components/chat/GroupLinkInput.svelte';
	import AvailableKeyPackageDirectory from '$lib/components/chat/AvailableKeyPackageDirectory.svelte';
	import type { AvailableKeyPackageWithCoordinator } from '$lib/queries/chatKeyPackageQueries';
	import { startChatWithKeyPackageAction } from '$lib/services/chatUiActions.svelte';
	import Users from '@lucide/svelte/icons/users';
	import LogIn from '@lucide/svelte/icons/log-in';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

	let {
		open = $bindable(false),
		onNavigate = () => {}
	}: {
		open?: boolean;
		onNavigate?: () => void;
	} = $props();

	let startingRef = $state('');
	let error = $state('');
	let joinOpen = $state(false);

	// bits-ui dialog content unmounts after the close animation, so the directory
	// (and its search state) remounts fresh each time the dialog opens.
	$effect(() => {
		if (open) {
			error = '';
			joinOpen = false;
		}
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
			await goto(resolve('/chat/[id]', { id: groupRouteId(groupId) }));
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
			<Dialog.Description>Message someone, start a group, or join with a link.</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-2">
			<a
				href={resolve('/chat/create-group')}
				onclick={handleCreateGroupClick}
				class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-muted/40"
			>
				<Users class="size-4 shrink-0 text-muted-foreground" />
				<span class="font-medium">Create group</span>
			</a>

			<Collapsible.Root bind:open={joinOpen}>
				<Collapsible.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							type="button"
							class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-muted/40"
						>
							<LogIn class="size-4 shrink-0 text-muted-foreground" />
							<span class="font-medium">Join group</span>
							<ChevronDown
								class="ml-auto size-4 text-muted-foreground transition-transform {joinOpen
									? 'rotate-180'
									: ''}"
							/>
						</button>
					{/snippet}
				</Collapsible.Trigger>
				<Collapsible.Content>
					<div class="px-3 pb-3">
						<GroupLinkInput
							onNavigate={() => {
								open = false;
								onNavigate();
							}}
						/>
					</div>
				</Collapsible.Content>
			</Collapsible.Root>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<p class="px-3 pt-3 text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
				Message someone
			</p>
			<AvailableKeyPackageDirectory
				onStartChat={startChat}
				{startingRef}
				showCount
				showCoordinatorFilter
				maxHeightClass="max-h-[32rem]"
				emptyMessage="No one else is discoverable here yet. Refresh, or ask them to publish a key package."
			/>
		</div>
	</Dialog.Content>
</Dialog.Root>
