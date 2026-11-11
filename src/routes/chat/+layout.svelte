<script lang="ts">
	import ChatSidebar from '$lib/components/chat/ChatSidebar.svelte';
	import ChatTabBar from '$lib/components/chat/ChatTabBar.svelte';
	import MediaLightbox from '$lib/components/chat/MediaLightbox.svelte';
	import LastResortConflictDialog from '$lib/components/chat/LastResortConflictDialog.svelte';
	import MigrationBanner from '$lib/components/chat/MigrationBanner.svelte';
	import SignerCapabilityBanner from '$lib/components/chat/SignerCapabilityBanner.svelte';
	import BatteryOptimizationBanner from '$lib/components/chat/BatteryOptimizationBanner.svelte';
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
	import {
		startWatchingAllGroups,
		watchableGroupsSignature
	} from '$lib/services/chatGroupWatch.svelte';
	import {
		maintainReachability,
		reconcilePublishedKeyPackagesForActiveAccount as reconcileKeyPackages,
		shouldReconcilePublishedKeyPackages
	} from '$lib/services/chatKeyPackages.svelte';
	import {
		autoAcceptJoinRequestWelcomesAction,
		loadAvailableKeyPackagesAction,
		loadWelcomeNotificationsAction,
		loadJoinRequestsAction
	} from '$lib/services/chatUiActions.svelte';
	import { listPendingJoinRequests } from '$lib/services/chatJoinRequests.svelte';
	import { listWelcomeNotifications } from '$lib/services/chatWelcomeNotifications.svelte';

	let { children } = $props();
	const chatLayout = setChatLayoutContext(createChatLayoutContext());

	// Stale-notification hygiene: clear shown notifications when the tab is attended again.
	onMount(initNotificationClearOnForeground);

	// Android hardware back button: close the keyboard / the mobile sidebar / any open overlay
	// first, then go up one level in the app's own hierarchy (chatUpHref), then leave the app with
	// a double-Back guard. Native only (no-op inside the helper).
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
	// the account or the watchable set changes (initial load, new/accepted groups).
	// Keyed on the set's signature so the per-ingest store writes behind `groups`
	// don't each schedule an ensure tick. Reconnection and recovery are owned by
	// chatGroupWatch.svelte's reconciler.
	const watchableKey = $derived(watchableGroupsSignature());
	$effect(() => {
		if (!$activeAccount || !watchableKey) return;
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

	// A join request is the one thing on this screen that resolves on somebody
	// else's schedule. While one waits, ask its own coordinator for Welcomes once
	// a minute, hidden tabs excluded (the per-coordinator query keeps its own
	// staleTime), and stop asking the moment the request does.
	const pendingJoinPollKey = $derived.by(() =>
		[...new Set(listPendingJoinRequests().map((entry) => entry.coordinatorKey))]
			.filter(Boolean)
			.sort()
			.join(',')
	);
	$effect(() => {
		const keys = pendingJoinPollKey ? pendingJoinPollKey.split(',') : [];
		if (keys.length === 0 || !$activeAccount) return;
		const check = () => {
			if (document.visibilityState !== 'visible') return;
			void untrack(async () => {
				for (const key of keys) {
					await loadWelcomeNotificationsAction(key).catch(() => {});
				}
			});
		};
		// One check on return to the tab, so coming back never waits out the interval.
		const timer = setInterval(check, 60_000);
		document.addEventListener('visibilitychange', check);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', check);
		};
	});

	// The request was the consent: the Welcome that answers it is accepted as soon
	// as its preview names the group, so the pending card becomes the chat with no
	// second confirmation. Every other Welcome stays for the notifications dialog.
	const pendingJoinAcceptKey = $derived.by(() => {
		const pending = listPendingJoinRequests().map((entry) => entry.gid);
		const previewed = listWelcomeNotifications()
			.filter((welcome) => Boolean(welcome.preview?.gid))
			.map((welcome) => welcome.id);
		return pending.length === 0 || previewed.length === 0
			? ''
			: `${pending.join(',')}|${previewed.join(',')}`;
	});
	$effect(() => {
		if (!pendingJoinAcceptKey || !$activeAccount) return;
		void untrack(() => autoAcceptJoinRequestWelcomesAction());
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
			// Reachability maintenance (auto-publish + callout truth) after the
			// fetch warm-up and marker reconcile; the mint gate inside holds off
			// until multi-device adoption when the fleet owns the last-resort.
			await maintainReachability();
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

<div class="flex h-dvh min-h-dvh bg-background pr-inset pl-inset text-foreground">
	<ChatSidebar mobileSidebarOpen={chatLayout.mobileSidebarOpen} />

	<!-- pt-safe here is the single status-bar clearance for EVERY /chat/* page (chat header,
	     config, coordinators, news, create-group, …). ChatHeader does NOT add its own — that
	     would double-pad /chat/[id]. Flex column: page content (min-h-0 flex-1) scrolls inside,
	     the mobile tab bar takes flow space at the bottom instead of overlapping content. -->
	<div class="relative flex min-w-0 flex-1 flex-col overflow-hidden pt-safe">
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
		<SignerCapabilityBanner />
		<BatteryOptimizationBanner />
		<div class="min-h-0 flex-1">
			{@render children()}
		</div>
		<ChatTabBar />
	</div>

	<MediaLightbox />
	<LastResortConflictDialog />
	{#if isNativePlatform()}
		<NativeGroupMetaSync />
	{/if}
</div>
