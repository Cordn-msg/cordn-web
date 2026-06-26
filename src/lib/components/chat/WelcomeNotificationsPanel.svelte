<script lang="ts">
	import { getDirectChatTargetPubkeyFromWelcome } from '$lib/components/chat/chatGroupDisplay';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import WelcomeNotificationCard from './WelcomeNotificationCard.svelte';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getCoordinatorLabel } from '$lib/services/chatCoordinators.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import {
		acceptWelcomeAction,
		rejectWelcomeAction,
		refreshWelcomeNotificationsAction
	} from '$lib/services/chatUiActions.svelte';
	import { useWelcomeNotifications } from '$lib/queries/chatWelcomeQueries';
	import {
		chatWelcomeNotificationsStore,
		isWelcomeSubmitting,
		listWelcomeNotifications,
		markAllWelcomeNotificationsRead
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import { normalizePubKey } from '$lib/utils';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';

	let {
		maxHeightClass = 'h-[min(26rem,60vh)]',
		emptyClass = 'rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground'
	}: {
		maxHeightClass?: string;
		emptyClass?: string;
	} = $props();

	const welcomeNotifications = $derived.by(() => listWelcomeNotifications());
	const useScrollableList = $derived.by(() => welcomeNotifications.length > 2);
	const welcomeNotificationsQuery = useWelcomeNotifications(() => $activeAccount?.pubkey);

	const groupProfileHints = useProfileHints(
		() => {
			const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
			return [
				...new Set(
					welcomeNotifications
						.flatMap((notification) => [
							getDirectChatTargetPubkeyFromWelcome(notification.preview?.name ?? ''),
							...(notification.preview?.memberPubkeys ?? [])
						])
						.map((pk) => normalizePubKey(pk))
						.filter((pubkey) => pubkey && pubkey !== activePubkey)
				)
			];
		},
		{ relays: metadataRelays }
	);

	async function refreshWelcomeNotifications() {
		if (!$activeAccount) return;
		await refreshWelcomeNotificationsAction();
	}

	async function acceptWelcome(notificationId: string) {
		if (!$activeAccount) return;
		await acceptWelcomeAction(notificationId);
	}

	async function rejectWelcome(notificationId: string) {
		if (!$activeAccount) return;
		await rejectWelcomeAction(notificationId);
	}
</script>

<div class="space-y-3">
	<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
		<h3>Welcome notifications</h3>
		<div class="flex flex-wrap gap-2">
			<Button type="button" variant="outline" size="sm" onclick={markAllWelcomeNotificationsRead}>
				Mark all as read
			</Button>
			<Button
				type="button"
				size="sm"
				onclick={refreshWelcomeNotifications}
				disabled={chatWelcomeNotificationsStore.loading || !$activeAccount}
			>
				{#if chatWelcomeNotificationsStore.loading}
					<Spinner class="mr-1 size-3" />
				{/if}
				{chatWelcomeNotificationsStore.loading ? 'Refreshing…' : 'Refresh'}
			</Button>
		</div>
	</div>

	{#if chatWelcomeNotificationsStore.error}
		<p class="text-sm text-destructive">{chatWelcomeNotificationsStore.error}</p>
	{:else if welcomeNotificationsQuery.error}
		<p class="text-sm text-destructive">
			{welcomeNotificationsQuery.error instanceof Error
				? welcomeNotificationsQuery.error.message
				: 'Failed to fetch welcome notifications'}
		</p>
	{/if}

	{#if !$activeAccount}
		<div class={emptyClass}>Log in to fetch welcomes.</div>
	{:else if welcomeNotifications.length === 0}
		<div class={emptyClass}>No welcomes fetched yet.</div>
	{:else if useScrollableList}
		<ScrollArea.Root class={`${maxHeightClass} rounded-xl border border-border`}>
			<div class="space-y-2 p-2.5">
				{#each welcomeNotifications as notification (notification.id)}
					<WelcomeNotificationCard
						{notification}
						profileHints={groupProfileHints}
						coordinatorLabel={getCoordinatorLabel(notification.coordinatorKey)}
						submitting={isWelcomeSubmitting(notification.id)}
						onAccept={() => acceptWelcome(notification.id)}
						onReject={() => rejectWelcome(notification.id)}
					/>
				{/each}
			</div>
			<ScrollArea.Scrollbar orientation="vertical" />
		</ScrollArea.Root>
	{:else}
		<div class="space-y-2">
			{#each welcomeNotifications as notification (notification.id)}
				<WelcomeNotificationCard
					{notification}
					profileHints={groupProfileHints}
					coordinatorLabel={getCoordinatorLabel(notification.coordinatorKey)}
					submitting={isWelcomeSubmitting(notification.id)}
					onAccept={() => acceptWelcome(notification.id)}
					onReject={() => rejectWelcome(notification.id)}
				/>
			{/each}
		</div>
	{/if}
</div>
