<script lang="ts">
	import ChatSidebar from '$lib/components/chat/ChatSidebar.svelte';
	import MediaLightbox from '$lib/components/chat/MediaLightbox.svelte';
	import LastResortConflictDialog from '$lib/components/chat/LastResortConflictDialog.svelte';
	import MigrationBanner from '$lib/components/chat/MigrationBanner.svelte';
	import NativeGroupMetaSync from '$lib/components/chat/NativeGroupMetaSync.svelte';
	import { isNativePlatform, initBackButtonHandler } from '$lib/services/nativeBridge';
	import { onMount, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import {
		createChatLayoutContext,
		setChatLayoutContext
	} from '$lib/components/chat/chatLayoutContext';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		initNotificationClearOnForeground,
		notifyForUnreadChatMessages,
		syncChatAttention
	} from '$lib/services/chatAttention.svelte';
	import { loadNewsReadState } from '$lib/news/newsReadState.svelte';
	import { chatReconnectStatusStore } from '$lib/services/chatReconnectStatus.svelte';
	import { signerReadinessStore } from '$lib/services/signerReadiness.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { startWatchingAllGroups } from '$lib/services/chatGroupWatch.svelte';
	import {
		reconcilePublishedKeyPackagesForActiveAccount as reconcileKeyPackages,
		shouldReconcilePublishedKeyPackages
	} from '$lib/services/chatKeyPackages.svelte';
	import {
		loadAvailableKeyPackagesAction,
		loadWelcomeNotificationsAction,
		loadJoinRequestsAction
	} from '$lib/services/chatUiActions.svelte';

	let { children } = $props();
	const chatLayout = setChatLayoutContext(createChatLayoutContext());

	// Stale-notification hygiene: clear shown notifications when the tab is attended again.
	onMount(initNotificationClearOnForeground);

	// Android hardware back button: close the mobile sidebar / any open overlay first, else
	// traverse SvelteKit history, else background the app. Native only (no-op inside the helper).
	onMount(() => {
		void initBackButtonHandler(() => {
			if (get(chatLayout.mobileSidebarOpen)) {
				chatLayout.mobileSidebarOpen.set(false);
				return true;
			}
			return false;
		});
	});

	const groups = $derived.by(() => listChatGroups());
	let startupSyncedFor = $state('');

	// Steady-state watch driver: ensure every watchable group is watched whenever
	// the account or the group set changes (initial load, new/accepted groups).
	// Reconnection and recovery are owned by chatGroupWatch.svelte's reconciler.
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
		if (!pubkey || startupSyncedFor === pubkey) return;
		startupSyncedFor = pubkey;
		void untrack(async () => {
			await loadAvailableKeyPackagesAction();
			if (shouldReconcilePublishedKeyPackages(pubkey)) {
				await reconcileKeyPackages();
			}
		});
	});

	$effect(() => {
		void groups.length;
		void $activeAccount?.pubkey;
		loadNewsReadState();
		syncChatAttention();
		void notifyForUnreadChatMessages();
	});
</script>

<div class="flex h-dvh min-h-dvh bg-background pr-safe pl-safe text-foreground">
	<ChatSidebar mobileSidebarOpen={chatLayout.mobileSidebarOpen} />

	<!-- pt-safe here is the single status-bar clearance for EVERY /chat/* page (chat header,
	     config, coordinators, news, create-group, …). ChatHeader does NOT add its own — that
	     would double-pad /chat/[id]. -->
	<div class="relative min-w-0 flex-1 overflow-hidden pt-safe">
		{#if signerReadinessStore.waiting}
			<!-- Identity gate (NIP-07 injection race) takes precedence over the sync
		     banner: waiting on the signer, not on coordinators. -->
			<div
				class="absolute inset-x-0 top-0 z-50 border-b border-border/60 bg-muted/60 px-2 py-1 text-sm text-muted-foreground backdrop-blur-sm"
			>
				Waiting for Nostr signer…
			</div>
		{:else if chatReconnectStatusStore.active}
			<div
				class="absolute inset-x-0 top-0 z-50 border-b border-border/60 bg-muted/60 px-2 py-1 text-sm text-muted-foreground backdrop-blur-sm"
			>
				{chatReconnectStatusStore.message}
			</div>
		{/if}

		<MigrationBanner />
		{@render children()}
	</div>

	<MediaLightbox />
	<LastResortConflictDialog />
	{#if isNativePlatform()}
		<NativeGroupMetaSync />
	{/if}
</div>
