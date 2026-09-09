<script lang="ts">
	import QrShareDialog from '$lib/components/QrShareDialog.svelte';
	import WelcomeNotificationCard from '$lib/components/chat/WelcomeNotificationCard.svelte';
	import JoinRequestCard from '$lib/components/chat/JoinRequestCard.svelte';
	import NewConversationDialog from '$lib/components/chat/NewConversationDialog.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getCoordinatorLabel,
		listKnownCoordinatorKeys
	} from '$lib/services/chatCoordinators.svelte';
	import { defaultProfileShareUrl, listProfileShareOptions } from '$lib/utils/profileShareOptions';
	import { metadataRelays } from '$lib/services/relay-pool';
	import {
		getUnreadWelcomeNotificationCount,
		listWelcomeNotifications,
		chatWelcomeNotificationsStore,
		isWelcomeSubmitting,
		markAllWelcomeNotificationsRead,
		type WelcomeNotificationEntry
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import {
		getUnreadJoinRequestCount,
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
	import { createQueries } from '@tanstack/svelte-query';
	import { getDirectChatTargetPubkeyFromWelcome } from '$lib/components/chat/chatGroupDisplay';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { normalizePubKey } from '$lib/utils';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Plus from '@lucide/svelte/icons/plus';
	import QrCodeIcon from '@lucide/svelte/icons/qr-code';

	type UnifiedItem =
		| { type: 'welcome'; data: WelcomeNotificationEntry }
		| { type: 'join-request'; data: JoinRequestEntry };

	let { collapsed = false }: { collapsed?: boolean } = $props();

	let notificationsOpen = $state(false);
	let profileShareOpen = $state(false);
	let newConversationOpen = $state(false);

	const unreadWelcomeNotifications = $derived.by(() => getUnreadWelcomeNotificationCount());
	const unreadJoinRequests = $derived.by(() => getUnreadJoinRequestCount());
	const unreadNotificationTotal = $derived.by(
		() => unreadWelcomeNotifications + unreadJoinRequests
	);
	// Per-coordinator observers (AGENTS.md): each coordinator polls and merges
	// into the welcome store on its own schedule — a faulty coordinator can't
	// stall the rest. The UI reads the store, not these query results.
	const notificationCoordinatorKeys = $derived.by(() => [...new Set(listKnownCoordinatorKeys())]);
	createQueries(() => ({
		queries: notificationCoordinatorKeys.map((key) =>
			welcomeNotificationsQueryOptions($activeAccount?.pubkey ?? '', key)
		)
	}));
	// Observe the join-requests query so invalidation (e.g. after accepting a
	// request) triggers a refetch and the `consumed` ack retires the accepted
	// row on the coordinator promptly. Without a persistent observer the ack
	// is deferred, the original row lingers, and a re-request from a user who
	// left/re-deleted the group is silently deduped against it — so admins
	// never see the re-request until the user sends twice. Mirrors welcomes.
	createQueries(() => ({
		queries: notificationCoordinatorKeys.map((key) =>
			joinRequestsQueryOptions($activeAccount?.pubkey ?? '', key)
		)
	}));

	// Profile-share links live in $lib/utils/profileShareOptions (shared with the
	// mobile Share tab); these thin deriveds keep the reactivity seam local.
	const profileShareOptions = $derived.by(() => listProfileShareOptions($activeAccount?.pubkey));
	const profileShareUrl = $derived.by(() => defaultProfileShareUrl($activeAccount?.pubkey));

	const welcomeNotifications = $derived.by(() => listWelcomeNotifications());
	const joinRequests = $derived.by(() => listJoinRequests());

	const unifiedItems = $derived.by(() => {
		const items: UnifiedItem[] = [
			...welcomeNotifications.map((w) => ({ type: 'welcome' as const, data: w })),
			...joinRequests.map((r) => ({ type: 'join-request' as const, data: r }))
		];
		return items.sort((a, b) => b.data.at - a.data.at);
	});

	const useScrollableList = $derived.by(() => unifiedItems.length > 2);
	const isLoading = $derived.by(
		() => chatWelcomeNotificationsStore.loading || chatJoinRequestsStore.loading
	);
	const hasError = $derived.by(
		() => chatWelcomeNotificationsStore.error || chatJoinRequestsStore.error
	);
	const errorMessage = $derived.by(
		() => chatWelcomeNotificationsStore.error || chatJoinRequestsStore.error || ''
	);

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
			return [...new Set([...welcomePubkeys, ...joinPubkeys, ...welcomeMemberPubkeys])];
		},
		{ relays: metadataRelays }
	);

	function getNotificationsButtonLabel() {
		if (unreadNotificationTotal > 0) {
			const parts: string[] = [];
			if (unreadWelcomeNotifications > 0) {
				parts.push(
					`${unreadWelcomeNotifications} invitation${unreadWelcomeNotifications === 1 ? '' : 's'}`
				);
			}
			if (unreadJoinRequests > 0) {
				parts.push(`${unreadJoinRequests} join request${unreadJoinRequests === 1 ? '' : 's'}`);
			}
			return `${unreadNotificationTotal} unread: ${parts.join(', ')}`;
		}
		return 'No unread notifications';
	}

	async function refreshAll() {
		if (!$activeAccount) return;
		await Promise.all([refreshWelcomeNotificationsAction(), refreshJoinRequestsAction()]);
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

	type QuickAction = {
		id: string;
		icon: typeof Plus;
		aria: string;
		title?: string;
		onclick?: () => void;
		active: boolean;
		badge: number;
		visible?: boolean;
	};

	// Single source of truth for the action set: labels, icons, handlers, and
	// state live here once instead of drifting across the three render shapes.
	const actions = $derived.by<QuickAction[]>(() => {
		const list: QuickAction[] = [
			{
				id: 'new',
				icon: Plus,
				aria: 'New conversation',
				onclick: () => (newConversationOpen = true),
				active: newConversationOpen,
				badge: 0
			},
			{
				id: 'notifications',
				icon: Inbox,
				aria: 'Open notifications',
				title: getNotificationsButtonLabel(),
				onclick: () => (notificationsOpen = true),
				active: notificationsOpen,
				badge: unreadNotificationTotal
			},
			{
				id: 'share',
				icon: QrCodeIcon,
				aria: 'Share profile',
				onclick: () => (profileShareOpen = true),
				active: profileShareOpen,
				badge: 0,
				visible: Boolean($activeAccount)
			}
		];
		return list.filter((action) => action.visible !== false);
	});
</script>

<!-- One compact icon row replaces the old labeled rows + collapsed ⋯ menu:
     Settings lives one box below (ProfileCard → /chat/config), Share and New
     conversation have tab/FAB equivalents on mobile — but desktop and the
     drawer still need one-tap access, and the Notifications inbox lives here. -->
<div class={`flex gap-1 ${collapsed ? 'flex-col items-center' : 'w-full justify-between'}`}>
	{#each actions as action (action.id)}
		<button
			type="button"
			onclick={action.onclick}
			class="relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors {action.active
				? 'bg-primary/10 text-foreground'
				: 'text-muted-foreground hover:bg-background hover:text-foreground'}"
			aria-label={action.aria}
			title={action.title ?? action.aria}
		>
			<action.icon class="size-4 shrink-0" />
			{#if action.badge > 0}
				<span
					class="absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground"
				>
					{action.badge > 99 ? '99+' : action.badge}
				</span>
			{/if}
		</button>
	{/each}
</div>

<Dialog.Root bind:open={notificationsOpen}>
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

{#if $activeAccount}
	<QrShareDialog
		bind:open={profileShareOpen}
		title="Share your profile"
		description="Share your public Cordn profile link as a QR code, or scan someone else's."
		data={profileShareUrl}
		shareOptions={profileShareOptions}
		copyLabel="Copy profile link"
		copiedLabel="Copied profile link"
	/>
{/if}

<NewConversationDialog bind:open={newConversationOpen} />
