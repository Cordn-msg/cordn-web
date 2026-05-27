<script lang="ts">
	import ChatSidebar from '$lib/components/chat/ChatSidebar.svelte';
	import { untrack } from 'svelte';
	import {
		createChatLayoutContext,
		setChatLayoutContext
	} from '$lib/components/chat/chatLayoutContext';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		notifyForUnreadChatMessages,
		syncChatAttention
	} from '$lib/services/chatAttention.svelte';
	import { chatReconnectStatusStore } from '$lib/services/chatReconnectStatus.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { chatGroupWatchStore, startWatchingAllGroups } from '$lib/services/chatGroupWatch.svelte';
	import {
		reconcilePublishedKeyPackagesForActiveAccount as reconcileKeyPackages,
		shouldReconcilePublishedKeyPackages
	} from '$lib/services/chatKeyPackages.svelte';
	import {
		loadCoordinatorRemoteKeyPackagesAction,
		loadWelcomeNotificationsAction
	} from '$lib/services/chatUiActions.svelte';

	let { children } = $props();
	const chatLayout = setChatLayoutContext(createChatLayoutContext());

	const groups = $derived.by(() => listChatGroups());
	let startupSyncedFor = $state('');

	$effect(() => {
		if (!$activeAccount || groups.length === 0) return;
		void untrack(() => startWatchingAllGroups());
	});

	$effect(() => {
		const pubkey = $activeAccount?.pubkey;
		if (!pubkey || chatGroupWatchStore.startup !== 'ready' || startupSyncedFor === pubkey) return;
		startupSyncedFor = pubkey;
		void untrack(async () => {
			await loadWelcomeNotificationsAction();
			await loadCoordinatorRemoteKeyPackagesAction(undefined);
			if (shouldReconcilePublishedKeyPackages(pubkey)) {
				await reconcileKeyPackages();
			}
		});
	});

	$effect(() => {
		void groups.length;
		void $activeAccount?.pubkey;
		syncChatAttention();
		void notifyForUnreadChatMessages();
	});
</script>

<div class="flex h-dvh min-h-dvh bg-background text-foreground">
	<ChatSidebar mobileSidebarOpen={chatLayout.mobileSidebarOpen} />

	<div class="min-w-0 flex-1 overflow-hidden">
		{#if chatReconnectStatusStore.active}
			<div
				class="border-b border-border/60 bg-muted/60 px-4 py-2 text-sm text-muted-foreground md:px-6"
			>
				{chatReconnectStatusStore.message}
			</div>
		{/if}

		{@render children()}
	</div>
</div>
