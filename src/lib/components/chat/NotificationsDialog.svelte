<script lang="ts">
	import { untrack } from 'svelte';
	import WelcomeNotificationCard from '$lib/components/chat/WelcomeNotificationCard.svelte';
	import JoinRequestCard from '$lib/components/chat/JoinRequestCard.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getCoordinatorLabel,
		listKnownCoordinatorKeys
	} from '$lib/services/chatCoordinators.svelte';
	import {
		listWelcomeNotifications,
		chatWelcomeNotificationsStore,
		isWelcomeSubmitting,
		markAllWelcomeNotificationsRead,
		type WelcomeNotificationEntry
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import {
		listJoinRequests,
		chatJoinRequestsStore,
		isJoinRequestSubmitting,
		markAllJoinRequestsRead,
		type JoinRequestEntry
	} from '$lib/services/chatJoinRequests.svelte';
	import {
		acceptWelcomeAction,
		rejectWelcomeAction,
		refreshWelcomeNotificationsAction,
		acceptJoinRequestAction,
		rejectJoinRequestAction,
		refreshJoinRequestsAction
	} from '$lib/services/chatUiActions.svelte';
	import { welcomeNotificationsQueryOptions } from '$lib/queries/chatWelcomeQueries';
	import { joinRequestsQueryOptions } from '$lib/queries/chatJoinRequestQueries';
	import { queryClient } from '$lib/query-client';
	import { getDirectChatTargetPubkeyFromWelcome } from '$lib/components/chat/chatGroupDisplay';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { normalizePubKey } from '$lib/utils';
	import { metadataRelays } from '$lib/services/relay-pool';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	type UnifiedItem =
		| { type: 'welcome'; data: WelcomeNotificationEntry }
		| { type: 'join-request'; data: JoinRequestEntry };

	const welcomeNotifications = $derived.by(() => listWelcomeNotifications());
	const joinRequests = $derived.by(() => listJoinRequests());

	// Per-coordinator polling (AGENTS.md): each coordinator resolves on its own
	// schedule and merges into the welcome/join stores as it lands — a faulty
	// coordinator can't stall the rest. The UI reads the stores, not query
	// results.
	//
	// Polling is imperative (fetchQuery over the same per-coordinator query
	// cache) instead of always-mounted createQueries observers: queryFns read
	// coordinator/health $state before their first await, which used to pollute
	// svelte-query's subscribe-$effect deps (TanStack/query#11541) — health
	// writes re-ran it, tearing down observers mid-flight (cancelling in-flight
	// fetches so data never landed) and mount-fetching the still-dataless
	// queries again: a self-sustaining welcome_take RPC storm (~3.2 nos2x
	// signs/sec). The queryFns now untrack those reads; this poll call is
	// untracked too so fetch reads never pollute the effect below, and polling
	// keeps no observers mounted at all.
	const coordinatorKeys = $derived.by(() => [...new Set(listKnownCoordinatorKeys())]);

	let isPollRefreshing = $state(false);
	// $state (not .raw): pollFailures is mutated via splice below and the error
	// banner derives from it — raw state mutations never notify.
	const pollFailures = $state<string[]>([]);

	async function pollNotifications() {
		const account = $activeAccount;
		if (!account) return;
		isPollRefreshing = true;
		try {
			const results = await Promise.allSettled(
				coordinatorKeys.map(async (key) => {
					// Shared cache, staleTime dedupes; per-key failures surface below.
					await Promise.all([
						queryClient.fetchQuery(welcomeNotificationsQueryOptions(account.pubkey, key)),
						queryClient.fetchQuery(joinRequestsQueryOptions(account.pubkey, key))
					]);
				})
			);
			pollFailures.splice(
				0,
				pollFailures.length,
				...results
					.map((result, index) =>
						result.status === 'rejected'
							? `${getCoordinatorLabel(coordinatorKeys[index])}: ${String(result.reason).replace(/^Error:\s*/, '')}`
							: ''
					)
					.filter(Boolean)
			);
		} finally {
			isPollRefreshing = false;
		}
	}

	// Immediate poll on mount/account/coordinator-set change, then every 5 min
	// (same cadence the query options' refetchInterval had). untrack: the poll
	// synchronously runs queryFn preludes (via fetchQuery); the account/keys
	// reads above are this effect's only intended dependencies — fetch reads
	// must not re-run/reset the interval.
	$effect(() => {
		const account = $activeAccount;
		if (!account || coordinatorKeys.length === 0) return;
		void untrack(() => pollNotifications());
		const timer = setInterval(() => void pollNotifications(), 5 * 60 * 1000);
		return () => clearInterval(timer);
	});

	const unifiedItems = $derived.by(() => {
		const items: UnifiedItem[] = [
			...welcomeNotifications.map((w) => ({ type: 'welcome' as const, data: w })),
			...joinRequests.map((r) => ({ type: 'join-request' as const, data: r }))
		];
		return items.sort((a, b) => b.data.at - a.data.at);
	});

	const useScrollableList = $derived(unifiedItems.length > 2);
	const isLoading = $derived(isPollRefreshing);
	const errorMessage = $derived.by(() => {
		return (
			chatWelcomeNotificationsStore.error || chatJoinRequestsStore.error || pollFailures.join('; ')
		);
	});
	const hasError = $derived(Boolean(errorMessage));

	const profileHints = useProfileHints(
		() => {
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			const welcomePubkeys = welcomeNotifications
				.map((n) => getDirectChatTargetPubkeyFromWelcome(n.preview?.name ?? ''))
				.filter((pk) => pk && pk !== activePubkey);
			const welcomeMemberPubkeys = welcomeNotifications
				.flatMap((n) => n.preview?.memberPubkeys ?? [])
				.map((pk) => normalizePubKey(pk))
				.filter((pk) => pk && pk !== activePubkey);
			const joinPubkeys = joinRequests
				.map((r) => r.requesterStablePubkey)
				.filter((pk) => pk && pk !== activePubkey);
			return [...new Set([...welcomePubkeys, ...welcomeMemberPubkeys, ...joinPubkeys])];
		},
		{ relays: metadataRelays }
	);

	async function refreshAll() {
		if (!$activeAccount) return;
		isPollRefreshing = true;
		try {
			await Promise.all([refreshWelcomeNotificationsAction(), refreshJoinRequestsAction()]);
		} finally {
			isPollRefreshing = false;
		}
	}

	function markAllRead() {
		markAllWelcomeNotificationsRead();
		markAllJoinRequestsRead();
	}

	async function handleAccept(item: UnifiedItem) {
		if (!$activeAccount) return;
		if (item.type === 'welcome') {
			await acceptWelcomeAction(item.data.id);
		} else {
			await acceptJoinRequestAction(item.data.id);
		}
	}

	async function handleReject(item: UnifiedItem) {
		if (!$activeAccount) return;
		if (item.type === 'welcome') {
			await rejectWelcomeAction(item.data.id);
		} else {
			await rejectJoinRequestAction(item.data.id);
		}
	}

	function isSubmitting(item: UnifiedItem): boolean {
		if (item.type === 'welcome') {
			return isWelcomeSubmitting(item.data.id);
		}
		return isJoinRequestSubmitting(item.data.id);
	}

	function getItemLabel(item: UnifiedItem): string {
		return getCoordinatorLabel(item.data.coordinatorKey);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] w-[min(calc(100vw-1.5rem),42rem)] sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Notifications</Dialog.Title>
			<Dialog.Description>
				Invitations to join groups, and requests to join yours.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-3">
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex flex-wrap gap-2">
					<Button type="button" variant="outline" size="sm" onclick={markAllRead}>
						Mark all as read
					</Button>
					<Button
						type="button"
						size="sm"
						onclick={refreshAll}
						disabled={isLoading || !$activeAccount}
					>
						{#if isLoading}
							<Spinner class="mr-1 size-3" />
						{/if}
						{isLoading ? 'Refreshing…' : 'Refresh'}
					</Button>
				</div>
			</div>

			{#if hasError}
				<p class="text-sm text-destructive">{errorMessage}</p>
			{/if}

			{#if !$activeAccount}
				<div
					class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
				>
					Log in to fetch notifications.
				</div>
			{:else if unifiedItems.length === 0}
				<div
					class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
				>
					No notifications yet.
				</div>
			{:else if useScrollableList}
				<ScrollArea.Root class="h-[min(26rem,60vh)] rounded-xl border border-border">
					<div class="space-y-2 p-2.5">
						{#each unifiedItems as item (item.type === 'welcome' ? item.data.id : item.data.id)}
							{#if item.type === 'welcome'}
								<WelcomeNotificationCard
									notification={item.data}
									{profileHints}
									coordinatorLabel={getItemLabel(item)}
									submitting={isSubmitting(item)}
									onAccept={() => handleAccept(item)}
									onReject={() => handleReject(item)}
								/>
							{:else}
								<JoinRequestCard
									entry={item.data}
									{profileHints}
									coordinatorLabel={getItemLabel(item)}
									submitting={isSubmitting(item)}
									onAccept={() => handleAccept(item)}
									onReject={() => handleReject(item)}
								/>
							{/if}
						{/each}
					</div>
					<ScrollArea.Scrollbar orientation="vertical" />
				</ScrollArea.Root>
			{:else}
				<div class="space-y-2">
					{#each unifiedItems as item (item.type === 'welcome' ? item.data.id : item.data.id)}
						{#if item.type === 'welcome'}
							<WelcomeNotificationCard
								notification={item.data}
								{profileHints}
								coordinatorLabel={getItemLabel(item)}
								submitting={isSubmitting(item)}
								onAccept={() => handleAccept(item)}
								onReject={() => handleReject(item)}
							/>
						{:else}
							<JoinRequestCard
								entry={item.data}
								{profileHints}
								coordinatorLabel={getItemLabel(item)}
								submitting={isSubmitting(item)}
								onAccept={() => handleAccept(item)}
								onReject={() => handleReject(item)}
							/>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
