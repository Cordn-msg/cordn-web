<script lang="ts">
	import {
		getDirectChatTargetPubkeyFromWelcome,
		resolveWelcomeDisplayName
	} from '$lib/components/chat/chatGroupDisplay';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getChatCoordinator } from '$lib/services/chatCoordinators.svelte';
	import { eventStore } from '$lib/services/eventStore';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import {
		acceptWelcomeAction,
		rejectWelcomeAction,
		refreshWelcomeNotificationsAction
	} from '$lib/services/chatUiActions.svelte';
	import { useWelcomeNotifications } from '$lib/queries/chatWelcomeQueries';
	import {
		chatWelcomeNotificationsStore,
		listWelcomeNotifications,
		markAllWelcomeNotificationsRead
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import { normalizePubKey } from '$lib/utils';
	import { ProfileModel } from 'applesauce-core/models';
	import { Metadata } from 'nostr-tools/kinds';
	import { untrack } from 'svelte';

	let {
		maxHeightClass = 'h-[min(26rem,60vh)]',
		emptyClass = 'rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground'
	}: {
		maxHeightClass?: string;
		emptyClass?: string;
	} = $props();

	let groupProfileHints = $state<
		Record<string, { name?: string; displayName?: string; nip05?: string }>
	>({});

	const activeAccountPubkey = $derived.by(() => $activeAccount?.pubkey ?? '');
	const welcomeNotifications = $derived.by(() => listWelcomeNotifications());
	const useScrollableList = $derived.by(() => welcomeNotifications.length > 2);
	const welcomeNotificationsQuery = useWelcomeNotifications(() => activeAccountPubkey);

	function getNotificationCoordinatorLabel(pubkey: string) {
		return getChatCoordinator(pubkey)?.label ?? `Coordinator ${pubkey.slice(0, 8)}`;
	}

	function getWelcomeAvatarFallback(notification: (typeof welcomeNotifications)[number]) {
		return notification.preview?.icon || notification.preview?.name?.slice(0, 1) || '#';
	}

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

	$effect(() => {
		const activePubkey = $activeAccount ? normalizePubKey($activeAccount.pubkey) : '';
		const welcomePubkeys = [
			...new Set(
				welcomeNotifications
					.map((notification) =>
						getDirectChatTargetPubkeyFromWelcome(notification.preview?.name ?? '')
					)
					.filter((pubkey) => pubkey && pubkey !== activePubkey)
			)
		];

		const subscriptions = welcomePubkeys.flatMap((pubkey) => [
			addressLoader({ kind: Metadata, pubkey, relays: metadataRelays }).subscribe(),
			eventStore.model(ProfileModel, pubkey).subscribe((profile) => {
				const current = untrack(() => groupProfileHints[pubkey]);
				const next = {
					name: profile?.name,
					displayName: profile?.display_name,
					nip05: profile?.nip05
				};

				if (
					current?.name === next.name &&
					current?.displayName === next.displayName &&
					current?.nip05 === next.nip05
				) {
					return;
				}

				groupProfileHints = { ...untrack(() => groupProfileHints), [pubkey]: next };
			})
		]);

		return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
	});
</script>

{#snippet notificationCard(notification: (typeof welcomeNotifications)[number])}
	<div
		class={`overflow-hidden rounded-lg border px-3 py-2.5 ${notification.readAt ? 'border-border bg-background/50' : 'border-primary/40 bg-primary/5'}`}
	>
		<div class="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
			<div class="flex min-w-0 gap-2.5">
				<Avatar class="h-9 w-9 shrink-0 border border-border bg-background">
					{#if notification.preview?.imageUrl}
						<AvatarImage
							src={notification.preview.imageUrl}
							alt={notification.preview.name}
							class="object-cover"
						/>
					{/if}
					<AvatarFallback class="bg-background text-xs font-medium">
						{getWelcomeAvatarFallback(notification)}
					</AvatarFallback>
				</Avatar>
				<div class="min-w-0 flex-1 space-y-0.5 overflow-hidden">
					<p class="truncate text-sm font-medium sm:whitespace-normal">
						{resolveWelcomeDisplayName({
							welcomeName: notification.preview?.name ?? '',
							profileHints: groupProfileHints
						})}
					</p>
					{#if notification.preview?.description}
						<p class="line-clamp-2 text-xs break-words text-muted-foreground">
							{notification.preview.description}
						</p>
					{/if}
					<p class="truncate text-[11px] text-muted-foreground">
						{getNotificationCoordinatorLabel(notification.coordinatorKey)}
					</p>
					<p class="text-[11px] text-muted-foreground">
						{new Date(notification.at).toLocaleString()}
					</p>
					{#if notification.acceptedGroupId}
						<p class="text-[11px] text-emerald-600 dark:text-emerald-400">
							Accepted into a local group
						</p>
					{/if}
				</div>
			</div>
			<div class="flex flex-wrap gap-1.5 sm:max-w-[13rem] sm:justify-end">
				{#if !notification.acceptedGroupId}
					<Button
						type="button"
						size="sm"
						class="h-8 px-3"
						onclick={() => acceptWelcome(notification.id)}
					>
						Accept
					</Button>
					<Button
						type="button"
						variant="destructive"
						size="sm"
						class="h-8 px-3"
						onclick={() => rejectWelcome(notification.id)}
					>
						Reject
					</Button>
				{/if}
			</div>
		</div>
	</div>
{/snippet}

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
					{@render notificationCard(notification)}
				{/each}
			</div>
			<ScrollArea.Scrollbar orientation="vertical" />
		</ScrollArea.Root>
	{:else}
		<div class="space-y-2">
			{#each welcomeNotifications as notification (notification.id)}
				{@render notificationCard(notification)}
			{/each}
		</div>
	{/if}
</div>
