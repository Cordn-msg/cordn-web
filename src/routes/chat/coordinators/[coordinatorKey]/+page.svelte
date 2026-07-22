<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ChatGroupListItem from '$lib/components/chat/ChatGroupListItem.svelte';
	import CoordinatorPurgeDialog from '$lib/components/chat/CoordinatorPurgeDialog.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Spinner } from '$lib/components/ui/spinner';
	import VirtualKeyPackageList, {
		type VirtualKeyPackageListItem
	} from '$lib/components/chat/VirtualKeyPackageList.svelte';
	import {
		getChatGroupDisplayTitle,
		getDirectChatTargetPubkeyFromWelcome
	} from '$lib/components/chat/chatGroupDisplay';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card';
	import WelcomeNotificationCard from '$lib/components/chat/WelcomeNotificationCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getChatCoordinator,
		getCoordinatorColor,
		getCoordinatorLabel
	} from '$lib/services/chatCoordinators.svelte';
	import { getCoordinatorServerInfo } from '$lib/services/coordinatorServerInfo.svelte';
	import { chatReconnectStatusStore } from '$lib/services/chatReconnectStatus.svelte';
	import {
		getCoordinatorHealthLabel,
		getCoordinatorHealthTone
	} from '$lib/services/coordinatorHealth.svelte';
	import {
		getChatGroup,
		listChatGroupMembers,
		listChatGroups
	} from '$lib/services/chatGroups.svelte';
	import {
		chatWelcomeNotificationsStore,
		isWelcomeSubmitting,
		listWelcomeNotificationsForCoordinator
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import {
		acceptWelcomeAction,
		refreshAvailableKeyPackagesAction,
		refreshCoordinatorWelcomeNotificationsAction
	} from '$lib/services/chatUiActions.svelte';
	import { availableKeyPackagesQueryOptions } from '$lib/queries/chatKeyPackageQueries';
	import { listChatKeyPackages, removeChatKeyPackage } from '$lib/services/chatKeyPackages.svelte';
	import { normalizePubKey } from '$lib/utils';
	import Boxes from '@lucide/svelte/icons/boxes';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Server from '@lucide/svelte/icons/server';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';

	let { params } = $props();

	const coordinatorKey = $derived.by(() => normalizePubKey(params.coordinatorKey));
	const coordinator = $derived.by(() => getChatCoordinator(coordinatorKey));
	const serverInfo = $derived.by(() => getCoordinatorServerInfo(coordinatorKey));
	const coordinatorDisplayLabel = $derived.by(() => getCoordinatorLabel(coordinatorKey));
	const relatedGroups = $derived.by(() =>
		listChatGroups().filter((group) => group.coordinatorKey === coordinatorKey)
	);
	const localKeyPackages = $derived.by(() => listChatKeyPackages());
	const pendingWelcomes = $derived.by(() => listWelcomeNotificationsForCoordinator(coordinatorKey));
	const loadingWelcomes = $derived.by(() => chatWelcomeNotificationsStore.loading);
	const welcomeError = $derived.by(() => chatWelcomeNotificationsStore.error);
	const relatedPublishedKeyPackages = $derived.by(() =>
		localKeyPackages.filter((entry) => entry.publishedCoordinatorKeys.includes(coordinatorKey))
	);
	const activePubkey = $derived.by(() =>
		$activeAccount ? normalizePubKey($activeAccount.pubkey) : ''
	);
	// Inline createQuery (not useAvailableKeyPackages) because the key depends on
	// the route param coordinatorKey, which updates reactively without remounting
	// this page. Reading it inside the createQuery closure keeps the query key in
	// sync when navigating between coordinators. The account-scoped hook stays
	// for the directory/dialog, matching welcome/join-request usage.
	const availableKeyPackagesQuery = createQuery(() =>
		availableKeyPackagesQueryOptions($activeAccount?.pubkey ?? '', coordinatorKey)
	);
	const remoteKeyPackages = $derived.by(() => availableKeyPackagesQuery.data ?? []);
	const ownedRemoteKeyPackages = $derived.by(() =>
		remoteKeyPackages.filter((entry) => normalizePubKey(entry.pk) === activePubkey)
	);
	const otherRemoteKeyPackages = $derived.by(() =>
		remoteKeyPackages.filter((entry) => normalizePubKey(entry.pk) !== activePubkey)
	);
	let removingKeyPackageRef = $state('');
	let showPurgeDialog = $state(false);
	let removeError = $state('');
	const welcomeProfileHints = useProfileHints(
		() => [
			...new Set(
				pendingWelcomes
					.map((n) => getDirectChatTargetPubkeyFromWelcome(n.preview?.name ?? ''))
					.filter((pubkey) => pubkey && pubkey !== activePubkey)
			)
		],
		{ relays: metadataRelays }
	);

	const ownedRemoteKeyPackagesWithState = $derived.by(() =>
		ownedRemoteKeyPackages.map((entry) => {
			const localCopy = localKeyPackages.find((record) => record.keyPackageRef === entry.kp_ref);
			return {
				entry,
				localCopy,
				state: localCopy ? 'owned + local copy available' : 'owned + local copy missing'
			};
		})
	);
	const ownedRemoteKeyPackageItems = $derived.by(() =>
		ownedRemoteKeyPackagesWithState.map((item) => ({
			id: item.entry.kp_ref,
			entry: {
				...item.entry,
				label: item.localCopy?.label || 'Remote owned key package'
			},
			pubkey: item.entry.pk,
			badge: item.state,
			actionLabel: removingKeyPackageRef === item.entry.kp_ref ? 'Removing…' : 'Remove',
			actionDisabled: removingKeyPackageRef === item.entry.kp_ref,
			onAction: () => removeOwnedKeyPackage(item.entry.kp_ref)
		}))
	);
	// Unified, deduped key-package list for the single card. Merges three former
	// sources — remote-owned (with local-copy state), local-published-not-on-
	// remote (drift, surfaced as “Local only”), and other-identities remote —
	// keyed by kp_ref so a package never appears twice. The same package can
	// legitimately land in more than one source (e.g. a local copy of someone
	// else's published package is both related-published and other-remote),
	// so every source checks-and-adds to one shared `seen` set in priority order.
	const keyPackageItems = $derived.by<VirtualKeyPackageListItem[]>(() => {
		const items: VirtualKeyPackageListItem[] = [];
		const seen = new Set<string>();
		for (const item of ownedRemoteKeyPackageItems) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			items.push(item);
		}
		for (const kp of relatedPublishedKeyPackages) {
			if (seen.has(kp.keyPackageRef)) continue;
			seen.add(kp.keyPackageRef);
			items.push({
				id: kp.keyPackageRef,
				entry: kp,
				badge: remoteKeyPackages.length > 0 ? 'Local only' : undefined
			});
		}
		for (const entry of otherRemoteKeyPackages) {
			if (seen.has(entry.kp_ref)) continue;
			seen.add(entry.kp_ref);
			items.push({ id: entry.kp_ref, entry });
		}
		return items;
	});
	const keyPackageEmptyMessage = $derived.by(() =>
		remoteKeyPackages.length === 0 && relatedPublishedKeyPackages.length === 0
			? 'No key packages published here yet.'
			: 'No key packages available.'
	);
	const coordinatorConnectionTone = $derived.by(() => getCoordinatorHealthTone(coordinatorKey));
	const coordinatorConnectionLabel = $derived.by(() => getCoordinatorHealthLabel(coordinatorKey));
	const coordinatorConnectionDotClass = $derived.by(() => {
		if (coordinatorConnectionTone === 'degraded') return 'bg-amber-500';
		if (coordinatorConnectionTone === 'healthy') return 'bg-emerald-500';
		return 'bg-muted-foreground/40';
	});
	const coordinatorConnectionCardClass = $derived.by(() => {
		if (coordinatorConnectionTone === 'degraded') {
			return 'border-amber-500/40 bg-amber-500/5';
		}

		return 'border-border bg-background';
	});
	const coordinatorConnectionDetail = $derived.by(() => {
		if (coordinatorConnectionTone === 'degraded') {
			return 'Recent coordinator requests failed. Reconnecting automatically.';
		}

		if (coordinatorConnectionTone === 'healthy') {
			return 'Coordinator is reachable.';
		}

		return 'Waiting for the first response from this coordinator.';
	});

	async function loadRemoteKeyPackages() {
		await refreshAvailableKeyPackagesAction(coordinatorKey);
	}

	async function loadPendingWelcomes() {
		await refreshCoordinatorWelcomeNotificationsAction(coordinatorKey);
	}

	function handleCoordinatorPurged() {
		goto(resolve('/chat/coordinators'));
	}

	function getAcceptedGroupLabel(groupId: string) {
		const group = getChatGroup(groupId);
		return group ? getRelatedGroupTitle(group) : 'Joined group';
	}

	function getRelatedGroupTitle(group: (typeof relatedGroups)[number]) {
		return getChatGroupDisplayTitle({
			group,
			activePubkey,
			profileHints: welcomeProfileHints,
			memberPubkeys: listChatGroupMembers(group.id).map((member) => member.stablePubkey)
		});
	}

	async function acceptWelcome(welcomeId: string) {
		await acceptWelcomeAction(welcomeId);
	}

	async function removeOwnedKeyPackage(keyPackageRef: string) {
		try {
			removingKeyPackageRef = keyPackageRef;
			removeError = '';
			await removeChatKeyPackage(keyPackageRef, { coordinatorKey });
			await loadRemoteKeyPackages();
		} catch (error) {
			removeError = error instanceof Error ? error.message : 'Failed to remove key package';
		} finally {
			removingKeyPackageRef = '';
		}
	}
</script>

<svelte:head>
	<title>{coordinatorDisplayLabel} | Cordn</title>
	<meta name="description" content="Coordinator detail workspace for Cordn." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Server class="size-4" />
			</div>
			<div class="min-w-0 space-y-2">
				<h1 class="text-lg font-semibold tracking-tight">
					{coordinatorDisplayLabel}
				</h1>
				<ProfileCard pubkey={coordinatorKey} />
			</div>
			<div class="ml-auto shrink-0">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								type="button"
								variant="outline"
								size="icon"
								class="h-10 w-10 rounded-xl"
								aria-label="Coordinator actions"
								title="Coordinator actions"
							>
								<EllipsisVertical class="size-4" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-48">
						<DropdownMenu.Item
							onclick={() => (showPurgeDialog = true)}
							class="gap-2 text-destructive data-highlighted:text-destructive"
						>
							<Trash2 class="size-4" />
							<span>Remove coordinator</span>
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto max-w-6xl space-y-6">
			<div class="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
				<Card.Root>
					<Card.Header>
						<Card.Title>Overview</Card.Title>
						<Card.Description
							>Saved coordinator profile, transport settings, and local usage summary.</Card.Description
						>
					</Card.Header>
					<Card.Content>
						<div class="space-y-4">
							<div class="flex items-center gap-3">
								<span
									class="h-4 w-4 rounded-full border border-border"
									style={`background-color: ${getCoordinatorColor(coordinator ?? { pubkey: coordinatorKey, color: undefined })};`}
									aria-hidden="true"
								></span>
								<div>
									<p class="font-medium">
										{coordinatorDisplayLabel}
									</p>
									<p class="text-sm text-muted-foreground">
										{coordinator?.isDefault ? 'Default coordinator' : 'Saved coordinator profile'}
									</p>
								</div>
							</div>

							<div class="space-y-3 rounded-2xl border border-border p-4 text-sm">
								<div>
									<p class="text-xs tracking-wide text-muted-foreground uppercase">Profile</p>
									<p class="mt-1 text-sm font-medium">
										{coordinator ? 'Saved locally' : 'Not saved locally'}
									</p>
								</div>
								<div>
									<p class="text-xs tracking-wide text-muted-foreground uppercase">Pubkey</p>
									<div class="mt-2">
										<ProfileCard pubkey={coordinatorKey} />
									</div>
								</div>
								<div>
									<p class="text-xs tracking-wide text-muted-foreground uppercase">Relays</p>
									<p class="mt-1 text-sm text-muted-foreground">
										{coordinator?.relays?.join(' · ') || 'Use client defaults'}
									</p>
								</div>
								{#if serverInfo.name || serverInfo.about || serverInfo.website || serverInfo.picture}
									<div>
										<p class="text-xs tracking-wide text-muted-foreground uppercase">
											Server metadata
										</p>
										<div class="mt-2 space-y-2">
											{#if serverInfo.name && serverInfo.name !== coordinatorDisplayLabel}
												<p class="text-sm font-medium wrap-break-word">{serverInfo.name}</p>
											{/if}
											{#if serverInfo.about}
												<p class="text-sm wrap-break-word text-muted-foreground">
													{serverInfo.about}
												</p>
											{/if}
											{#if serverInfo.website}
												<!-- eslint-disable svelte/no-navigation-without-resolve -->
												<a
													href={serverInfo.website}
													target="_blank"
													rel="noopener noreferrer"
													class="inline-block text-sm break-all text-primary hover:underline"
												>
													{serverInfo.website}
												</a>
												<!-- eslint-enable svelte/no-navigation-without-resolve -->
											{/if}
											{#if serverInfo.picture}
												<img
													src={serverInfo.picture}
													alt=""
													class="h-12 w-12 rounded-lg border border-border object-cover"
												/>
											{/if}
										</div>
									</div>
								{/if}
								<div>
									<p class="text-xs tracking-wide text-muted-foreground uppercase">Connection</p>
									<div class={`mt-2 rounded-2xl border p-4 ${coordinatorConnectionCardClass}`}>
										<div class="flex items-start gap-3">
											<span
												class={`mt-0.5 h-3 w-3 shrink-0 rounded-full ${coordinatorConnectionDotClass}`}
												aria-hidden="true"
											></span>
											<div class="min-w-0 space-y-1">
												<p class="font-medium">{coordinatorConnectionLabel}</p>
												<p class="text-sm text-muted-foreground">{coordinatorConnectionDetail}</p>
												{#if chatReconnectStatusStore.active && coordinatorConnectionTone !== 'healthy'}
													<p class="text-xs text-muted-foreground">
														Visible while reconnect activity is in progress.
													</p>
												{/if}
											</div>
										</div>
									</div>
								</div>
								<div>
									<p class="text-xs tracking-wide text-muted-foreground uppercase">Local groups</p>
									<p class="mt-1 text-sm font-medium">{relatedGroups.length}</p>
								</div>
								<div>
									<p class="text-xs tracking-wide text-muted-foreground uppercase">
										Published local key packages
									</p>
									<p class="mt-1 text-sm font-medium">{relatedPublishedKeyPackages.length}</p>
								</div>
							</div>
						</div>
					</Card.Content>
					<Card.Footer class="flex-wrap justify-end gap-2">
						<Button href={resolve('/chat/coordinators')} variant="outline"
							>Back to coordinators</Button
						>
						<Button href={`${resolve('/chat/create-group')}?coordinator=${coordinatorKey}`}
							>Create group here</Button
						>
					</Card.Footer>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Groups using this coordinator</Card.Title>
						<Card.Description>Local group inventory for this coordinator boundary.</Card.Description
						>
					</Card.Header>
					<Card.Content>
						<div class="space-y-3">
							{#if relatedGroups.length === 0}
								<div
									class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
								>
									No local groups use this coordinator yet.
								</div>
							{:else}
								{#each relatedGroups as group (group.id)}
									<ChatGroupListItem
										{group}
										href={resolve('/chat/[id]', { id: group.id })}
										preview={group.metadata?.description || 'Coordinator-assisted messaging'}
										profileHints={welcomeProfileHints}
									/>
								{/each}
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			</div>

			<Card.Root>
				<Card.Header>
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div class="space-y-1">
							<Card.Title>Key packages</Card.Title>
							<Card.Description>
								Local key packages published here plus the remote coordinator directory. Yours show
								a local-copy state; others appear read-only.
							</Card.Description>
						</div>
						{#if $activeAccount}
							<Button
								type="button"
								variant="outline"
								size="sm"
								onclick={loadRemoteKeyPackages}
								disabled={availableKeyPackagesQuery.isFetching}
							>
								{#if availableKeyPackagesQuery.isFetching}
									<Spinner class="mr-2 size-4" />
								{:else}
									<Boxes class="mr-2 size-4" />
								{/if}
								{availableKeyPackagesQuery.isFetching ? 'Loading…' : 'Refresh remote'}
							</Button>
						{/if}
					</div>
				</Card.Header>
				<Card.Content>
					{#if !$activeAccount}
						<div class="space-y-3">
							<p class="text-sm text-muted-foreground">
								Log in to inspect and manage key packages for this coordinator.
							</p>
							<AccountLoginDialog />
						</div>
					{:else}
						<div class="space-y-3">
							{#if availableKeyPackagesQuery.error}
								<p class="text-sm text-destructive">
									{availableKeyPackagesQuery.error instanceof Error
										? availableKeyPackagesQuery.error.message
										: 'Failed to load remote key packages'}
								</p>
							{/if}
							{#if removeError}
								<p class="text-sm text-destructive">{removeError}</p>
							{/if}
							<VirtualKeyPackageList
								items={keyPackageItems}
								emptyMessage={keyPackageEmptyMessage}
							/>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Welcomes</Card.Title>
					<Card.Description
						>Fetch and inspect pending welcomes queued for the active identity on this coordinator.</Card.Description
					>
				</Card.Header>
				<Card.Content>
					{#if !$activeAccount}
						<div class="space-y-3">
							<p class="text-sm text-muted-foreground">
								Log in to fetch welcomes from this coordinator.
							</p>
							<AccountLoginDialog />
						</div>
					{:else}
						<div class="space-y-3">
							<div class="flex flex-wrap gap-2">
								<Button type="button" onclick={loadPendingWelcomes} disabled={loadingWelcomes}>
									{#if loadingWelcomes}
										<Spinner class="mr-2 size-4" />
									{:else}
										<Inbox class="mr-2 size-4" />
									{/if}
									{loadingWelcomes ? 'Fetching welcomes…' : 'Fetch pending welcomes'}
								</Button>
							</div>
							{#if welcomeError}
								<p class="text-sm text-destructive">{welcomeError}</p>
							{/if}
							{#if pendingWelcomes.length === 0}
								<div
									class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
								>
									No fetched welcomes yet.
								</div>
							{:else}
								<div class="space-y-3">
									{#each pendingWelcomes as welcome (welcome.id)}
										<WelcomeNotificationCard
											notification={welcome}
											profileHints={welcomeProfileHints}
											showReject={false}
											showCoordinatorLabel={false}
											acceptedGroupLabel={getAcceptedGroupLabel(welcome.acceptedGroupId || '')}
											submitting={isWelcomeSubmitting(welcome.id)}
											onAccept={() => acceptWelcome(welcome.id)}
										/>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>

		<CoordinatorPurgeDialog
			bind:open={showPurgeDialog}
			pubkey={coordinatorKey}
			label={coordinatorDisplayLabel}
			onpurged={handleCoordinatorPurged}
		/>
	</div>
</div>
