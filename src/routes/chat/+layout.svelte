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
		loadWelcomeNotificationsAction,
		loadJoinRequestsAction
	} from '$lib/services/chatUiActions.svelte';

	let { children } = $props();
	const chatLayout = setChatLayoutContext(createChatLayoutContext());

	const groups = $derived.by(() => listChatGroups());
	let startupSyncedFor = $state('');

	$effect(() => {
		if (!$activeAccount || groups.length === 0) return;
		void untrack(() => startWatchingAllGroups());
	});

	let startupWelcomesSyncedFor = $state('');
	let startupWelcomesLoadingFor = $state('');

	$effect(() => {
		const pubkey = $activeAccount?.pubkey;
		if (!pubkey || startupWelcomesSyncedFor === pubkey || startupWelcomesLoadingFor === pubkey)
			return;

		startupWelcomesLoadingFor = pubkey;
		void untrack(async () => {
			try {
				await loadWelcomeNotificationsAction();
			} catch (error) {
				console.warn(
					'Failed to load welcome notifications during chat startup',
					error instanceof Error ? error.message : error
				);
			} finally {
				if ($activeAccount?.pubkey === pubkey) {
					startupWelcomesSyncedFor = pubkey;
				}
				if (startupWelcomesLoadingFor === pubkey) {
					startupWelcomesLoadingFor = '';
				}
			}
		});
	});

	let startupJoinRequestsSyncedFor = $state('');
	let startupJoinRequestsLoadingFor = $state('');

	$effect(() => {
		const pubkey = $activeAccount?.pubkey;
		if (
			!pubkey ||
			chatGroupWatchStore.startup !== 'ready' ||
			startupJoinRequestsSyncedFor === pubkey ||
			startupJoinRequestsLoadingFor === pubkey
		)
			return;

		startupJoinRequestsLoadingFor = pubkey;
		void untrack(async () => {
			try {
				await loadJoinRequestsAction();
			} catch (error) {
				console.warn(
					'Failed to load join requests during chat startup',
					error instanceof Error ? error.message : error
				);
			} finally {
				if ($activeAccount?.pubkey === pubkey) {
					startupJoinRequestsSyncedFor = pubkey;
				}
				if (startupJoinRequestsLoadingFor === pubkey) {
					startupJoinRequestsLoadingFor = '';
				}
			}
		});
	});

	$effect(() => {
		const pubkey = $activeAccount?.pubkey;
		if (!pubkey || chatGroupWatchStore.startup !== 'ready' || startupSyncedFor === pubkey) return;
		startupSyncedFor = pubkey;
		void untrack(async () => {
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

	<div class="relative min-w-0 flex-1 overflow-hidden">
		{#if chatReconnectStatusStore.active}
			<div
				class="absolute inset-x-0 top-0 z-50 border-b border-border/60 bg-muted/60 px-2 py-1 text-sm text-muted-foreground backdrop-blur-sm"
			>
				{chatReconnectStatusStore.message}
			</div>
		{/if}

		{@render children()}
	</div>
</div>
