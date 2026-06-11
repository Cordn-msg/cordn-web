<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import QrCode from '$lib/components/QrCode.svelte';
	import WelcomeNotificationCard from '$lib/components/chat/WelcomeNotificationCard.svelte';
	import JoinRequestCard from '$lib/components/chat/JoinRequestCard.svelte';
	import NewConversationDialog from '$lib/components/chat/NewConversationDialog.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as ScrollArea from '$lib/components/ui/scroll-area';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { getCoordinatorLabel } from '$lib/services/chatCoordinators.svelte';
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
	import { useWelcomeNotifications } from '$lib/queries/chatWelcomeQueries';
	import { getDirectChatTargetPubkeyFromWelcome } from '$lib/components/chat/chatGroupDisplay';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { normalizePubKey } from '$lib/utils';
	import { nip19 } from 'nostr-tools';
	import Bolt from '@lucide/svelte/icons/bolt';
	import Copy from '@lucide/svelte/icons/copy';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Menu from '@lucide/svelte/icons/menu';
	import Plus from '@lucide/svelte/icons/plus';
	import QrCodeIcon from '@lucide/svelte/icons/qr-code';

	type UnifiedItem =
		| { type: 'welcome'; data: WelcomeNotificationEntry }
		| { type: 'join-request'; data: JoinRequestEntry };

	let {
		collapsed = false,
		onNavigate = () => {}
	}: {
		collapsed?: boolean;
		onNavigate?: () => void;
	} = $props();

	let notificationsOpen = $state(false);
	let profileShareOpen = $state(false);
	let copiedProfileLink = $state(false);
	let newConversationOpen = $state(false);

	const unreadWelcomeNotifications = $derived.by(() => getUnreadWelcomeNotificationCount());
	const unreadJoinRequests = $derived.by(() => getUnreadJoinRequestCount());
	const unreadNotificationTotal = $derived.by(
		() => unreadWelcomeNotifications + unreadJoinRequests
	);
	useWelcomeNotifications($activeAccount?.pubkey);
	// Join requests are now loaded via layout effect when app is ready

	const profileSharePath = $derived.by(() => {
		if (!$activeAccount) return '';
		return resolve('/p/[identifier]', { identifier: nip19.npubEncode($activeAccount.pubkey) });
	});
	const profileShareUrl = $derived.by(() => {
		if (!profileSharePath) return '';
		return browser ? new URL(profileSharePath, page.url).toString() : profileSharePath;
	});

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

	function isActive(href: string) {
		return page.url.pathname === href;
	}

	function getNotificationsButtonLabel() {
		if (unreadNotificationTotal > 0) {
			const parts: string[] = [];
			if (unreadWelcomeNotifications > 0) {
				parts.push(
					`${unreadWelcomeNotifications} welcome${unreadWelcomeNotifications === 1 ? '' : 's'}`
				);
			}
			if (unreadJoinRequests > 0) {
				parts.push(`${unreadJoinRequests} join request${unreadJoinRequests === 1 ? '' : 's'}`);
			}
			return `${unreadNotificationTotal} unread: ${parts.join(', ')}`;
		}
		return 'No unread notifications';
	}

	async function copyProfileShareUrl() {
		if (!profileShareUrl || !browser) return;
		await navigator.clipboard.writeText(profileShareUrl);
		copiedProfileLink = true;
		setTimeout(() => {
			copiedProfileLink = false;
		}, 1500);
	}

	async function navigateToConfig() {
		onNavigate();
		await goto(resolve('/chat/config'));
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
</script>

{#if collapsed}
	<div class="flex justify-center">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						type="button"
						variant="ghost"
						size="icon"
						class="h-12 w-12 rounded-xl"
						aria-label="Open actions"
						title="Open actions"
					>
						<Menu class="size-5" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-56">
				<DropdownMenu.Item onclick={() => (newConversationOpen = true)} class="gap-2">
					<Plus class="size-4" />
					<span>New conversation</span>
				</DropdownMenu.Item>

				<DropdownMenu.Item onclick={() => (notificationsOpen = true)} class="gap-2">
					<span class="relative flex items-center">
						<Inbox class="size-4" />
						{#if unreadNotificationTotal > 0}
							<span
								class="ml-2 min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] leading-none font-semibold text-primary-foreground"
							>
								{unreadNotificationTotal}
							</span>
						{/if}
					</span>
					<span>Notifications</span>
				</DropdownMenu.Item>

				{#if $activeAccount}
					<DropdownMenu.Item onclick={() => (profileShareOpen = true)} class="gap-2">
						<QrCodeIcon class="size-4" />
						<span>Share profile</span>
					</DropdownMenu.Item>
				{/if}

				<DropdownMenu.Item onclick={navigateToConfig} class="gap-2">
					<Bolt class="size-4" />
					<span>Config</span>
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
{:else}
	<div class="grid gap-2 {$activeAccount ? 'grid-cols-4' : 'grid-cols-3'}">
		<button
			type="button"
			onclick={() => (newConversationOpen = true)}
			class="flex items-center justify-center rounded-xl border border-transparent px-3 py-3 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
			aria-label="New conversation"
			title="New conversation"
		>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
			>
				<Plus class="size-4" />
			</div>
		</button>

		<button
			type="button"
			onclick={() => (notificationsOpen = true)}
			class="relative flex items-center justify-center rounded-xl border px-3 py-3 text-sm transition-colors {notificationsOpen
				? 'border-primary bg-primary/10 text-foreground'
				: 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}"
			aria-label="Open notifications"
			title={getNotificationsButtonLabel()}
		>
			<div
				class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
			>
				<Inbox class="size-4" />
				{#if unreadNotificationTotal > 0}
					<span
						class="absolute -top-1 -right-1 min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] leading-none font-semibold text-primary-foreground"
					>
						{unreadNotificationTotal}
					</span>
				{/if}
			</div>
		</button>

		{#if $activeAccount}
			<button
				type="button"
				onclick={() => (profileShareOpen = true)}
				class="flex items-center justify-center rounded-xl border px-3 py-3 text-sm transition-colors {profileShareOpen
					? 'border-primary bg-primary/10 text-foreground'
					: 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}"
				aria-label="Share profile"
				title="Share profile"
			>
				<div
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
				>
					<QrCodeIcon class="size-4" />
				</div>
			</button>
		{/if}

		<a
			href={resolve('/chat/config')}
			onclick={onNavigate}
			class="flex items-center justify-center rounded-xl border px-3 py-3 text-sm transition-colors {isActive(
				'/chat/config'
			)
				? 'border-primary bg-primary/10 text-foreground'
				: 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'}"
			aria-label="Open config"
			title="Open config"
		>
			<div
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
			>
				<Bolt class="size-4" />
			</div>
		</a>
	</div>
{/if}

<Dialog.Root bind:open={notificationsOpen}>
	<Dialog.Content class="max-h-[90vh] w-[min(calc(100vw-1.5rem),42rem)] sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Notifications</Dialog.Title>
			<Dialog.Description>
				Welcomes and join requests fetched across known coordinators.
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
	<Dialog.Root bind:open={profileShareOpen}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>Share your profile</Dialog.Title>
				<Dialog.Description>Share your public Cordn profile link as a QR code.</Dialog.Description>
			</Dialog.Header>

			<div class="flex flex-col items-center gap-4 py-2">
				<QrCode data={profileShareUrl} size={220} />
				<p
					class="w-full rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs break-all text-muted-foreground"
				>
					{profileShareUrl}
				</p>
				<Button type="button" variant="outline" class="w-full" onclick={copyProfileShareUrl}>
					<Copy class="mr-2 size-4" />
					{copiedProfileLink ? 'Copied profile link' : 'Copy profile link'}
				</Button>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}

<NewConversationDialog bind:open={newConversationOpen} {onNavigate} />
