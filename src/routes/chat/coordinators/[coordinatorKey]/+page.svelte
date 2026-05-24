<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import KeyPackageCard from '$lib/components/chat/KeyPackageCard.svelte';
	import VirtualKeyPackageList from '$lib/components/chat/VirtualKeyPackageList.svelte';
	import {
		getChatGroupDisplayTitle,
		getDirectChatTargetPubkeyFromWelcome,
		resolveWelcomeDisplayName
	} from '$lib/components/chat/chatGroupDisplay';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { resolve } from '$app/paths';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getChatCoordinator,
		getCoordinatorColor,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import {
		getChatGroup,
		listChatGroupMembers,
		listChatGroups
	} from '$lib/services/chatGroups.svelte';
	import {
		chatWelcomeNotificationsStore,
		listWelcomeNotificationsForCoordinator,
		markWelcomeNotificationRead
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import {
		acceptWelcomeAction,
		coordinatorDetailsActionsStore,
		hasLoadedCoordinatorRemoteKeyPackages,
		loadCoordinatorRemoteKeyPackagesAction,
		refreshCoordinatorWelcomeNotificationsAction
	} from '$lib/services/chatUiActions.svelte';
	import { listChatKeyPackages, removeChatKeyPackage } from '$lib/services/chatKeyPackages.svelte';
	import { normalizePubKey } from '$lib/utils';
	import Boxes from '@lucide/svelte/icons/boxes';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Server from '@lucide/svelte/icons/server';
	import { ProfileModel } from 'applesauce-core/models';
	import { Metadata } from 'nostr-tools/kinds';
	import { untrack } from 'svelte';
	import { eventStore } from '$lib/services/eventStore';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';

	let { params } = $props();

	const coordinatorKey = $derived.by(() => normalizePubKey(params.coordinatorKey));
	const coordinator = $derived.by(() => getChatCoordinator(coordinatorKey));
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
	const remoteKeyPackages = $derived.by(() =>
		coordinatorDetailsActionsStore.coordinatorKey === coordinatorKey
			? coordinatorDetailsActionsStore.remoteKeyPackages
			: []
	);
	const hasCachedRemoteKeyPackages = $derived.by(() =>
		hasLoadedCoordinatorRemoteKeyPackages(coordinatorKey)
	);
	const ownedRemoteKeyPackages = $derived.by(() =>
		remoteKeyPackages.filter((entry) => normalizePubKey(entry.pk) === activePubkey)
	);
	const otherRemoteKeyPackages = $derived.by(() =>
		remoteKeyPackages.filter((entry) => normalizePubKey(entry.pk) !== activePubkey)
	);
	let removingKeyPackageRef = $state('');
	let removeError = $state('');
	let welcomeProfileHints = $state<
		Record<string, { name?: string; displayName?: string; nip05?: string }>
	>({});

	$effect(() => {
		const welcomePubkeys = [
			...new Set(
				pendingWelcomes
					.map((n) => getDirectChatTargetPubkeyFromWelcome(n.preview?.name ?? ''))
					.filter((pubkey) => pubkey && pubkey !== activePubkey)
			)
		];
		const subscriptions = welcomePubkeys.flatMap((pubkey) => [
			addressLoader({ kind: Metadata, pubkey, relays: metadataRelays }).subscribe(),
			eventStore.model(ProfileModel, pubkey).subscribe((profile) => {
				const current = untrack(() => welcomeProfileHints[pubkey]);
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
				welcomeProfileHints = { ...untrack(() => welcomeProfileHints), [pubkey]: next };
			})
		]);

		return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
	});

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
	const otherRemoteKeyPackageItems = $derived.by(() =>
		otherRemoteKeyPackages.map((entry) => ({
			id: entry.kp_ref,
			entry,
			pubkey: entry.pk
		}))
	);

	async function loadRemoteKeyPackages() {
		await loadCoordinatorRemoteKeyPackagesAction(coordinatorKey, {
			force: hasCachedRemoteKeyPackages
		});
	}

	async function loadPendingWelcomes() {
		await refreshCoordinatorWelcomeNotificationsAction(coordinatorKey);
	}

	function storeCoordinator() {
		upsertChatCoordinator({ pubkey: coordinatorKey });
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

	function getWelcomeAvatarFallback(welcome: (typeof pendingWelcomes)[number]) {
		return welcome.preview?.icon || welcome.preview?.name?.slice(0, 1) || '#';
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
	<title>{coordinator?.label || 'Coordinator'} | Cordn</title>
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
					{coordinator?.label || `Coordinator ${coordinatorKey.slice(0, 8)}`}
				</h1>
				<ProfileCard pubkey={coordinatorKey} />
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
										{coordinator?.label || `Coordinator ${coordinatorKey.slice(0, 8)}`}
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
						{#if !coordinator}
							<Button type="button" variant="outline" onclick={storeCoordinator}
								>Save locally</Button
							>
						{/if}
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
									<a
										href={resolve('/chat/[id]', { id: group.id })}
										class="block rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/40"
									>
										<p class="font-medium">{getRelatedGroupTitle(group)}</p>
										<p class="mt-1 text-sm text-muted-foreground">
											{group.metadata?.description || 'Coordinator-assisted messaging'}
										</p>
									</a>
								{/each}
							{/if}
						</div>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Local key packages published here</Card.Title>
						<Card.Description
							>Saved key packages that reference this coordinator pubkey.</Card.Description
						>
					</Card.Header>
					<Card.Content>
						<div class="space-y-3">
							{#if relatedPublishedKeyPackages.length === 0}
								<div
									class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
								>
									No saved key packages reference this coordinator yet.
								</div>
							{:else}
								{#each relatedPublishedKeyPackages as keyPackage (keyPackage.keyPackageRef)}
									<KeyPackageCard entry={keyPackage} />
								{/each}
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			</div>

			<div class="grid gap-6 xl:grid-cols-2">
				<Card.Root>
					<Card.Header>
						<Card.Title>Owned key packages</Card.Title>
						<Card.Description>
							Remote key packages whose credential pubkey matches the active account.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						{#if !$activeAccount}
							<div class="space-y-3">
								<p class="text-sm text-muted-foreground">
									Log in to inspect remote coordinator state.
								</p>
								<AccountLoginDialog />
							</div>
						{:else}
							<div class="space-y-3">
								<div class="flex flex-wrap gap-2">
									<Button
										type="button"
										onclick={loadRemoteKeyPackages}
										disabled={coordinatorDetailsActionsStore.loadingKeyPackages}
									>
										<Boxes class="mr-2 size-4" />
										{coordinatorDetailsActionsStore.loadingKeyPackages
											? 'Loading remote key packages…'
											: hasCachedRemoteKeyPackages
												? 'Refresh remote key packages'
												: 'Load remote key packages'}
									</Button>
								</div>
								{#if coordinatorDetailsActionsStore.keyPackageError}
									<p class="text-sm text-destructive">
										{coordinatorDetailsActionsStore.keyPackageError}
									</p>
								{/if}
								{#if remoteKeyPackages.length === 0}
									<div
										class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
									>
										Load remote data to inspect owned key packages.
									</div>
								{:else if ownedRemoteKeyPackagesWithState.length === 0}
									<div
										class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
									>
										No remote key packages owned by the active account were found.
									</div>
								{:else}
									<div class="space-y-3">
										{#if removeError}
											<p class="text-sm text-destructive">{removeError}</p>
										{/if}
										<VirtualKeyPackageList items={ownedRemoteKeyPackageItems} />
									</div>
								{/if}
							</div>
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Other available key packages</Card.Title>
						<Card.Description
							>Remote directory entries published by other credential pubkeys.</Card.Description
						>
					</Card.Header>
					<Card.Content>
						<div class="space-y-3">
							{#if remoteKeyPackages.length === 0}
								<div
									class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
								>
									Load remote key packages to inspect the coordinator directory.
								</div>
							{:else if otherRemoteKeyPackages.length === 0}
								<div
									class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
								>
									No remote key packages from other identities are currently visible.
								</div>
							{:else}
								<VirtualKeyPackageList items={otherRemoteKeyPackageItems} />
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			</div>

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
									<Inbox class="mr-2 size-4" />
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
										<div class="rounded-xl border border-border px-4 py-3">
											<div class="flex items-start justify-between gap-3">
												<div class="flex min-w-0 gap-3">
													<Avatar class="h-12 w-12 shrink-0 border border-border bg-background">
														{#if welcome.preview?.imageUrl}
															<AvatarImage
																src={welcome.preview.imageUrl}
																alt={welcome.preview.name}
																class="object-cover"
															/>
														{/if}
														<AvatarFallback class="bg-background text-base font-medium">
															{getWelcomeAvatarFallback(welcome)}
														</AvatarFallback>
													</Avatar>
													<div class="min-w-0">
														<p class="font-medium">
															{resolveWelcomeDisplayName({
																welcomeName: welcome.preview?.name ?? '',
																profileHints: welcomeProfileHints
															})}
														</p>
														{#if welcome.preview?.description}
															<p class="mt-1 text-sm text-muted-foreground">
																{welcome.preview.description}
															</p>
														{/if}
														<p class="mt-2 text-xs text-muted-foreground">
															{new Date(welcome.at).toLocaleString()}
														</p>
														{#if welcome.acceptedGroupId}
															<p class="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
																Accepted into {getAcceptedGroupLabel(welcome.acceptedGroupId)}
															</p>
														{/if}
													</div>
												</div>
												<div class="flex shrink-0 gap-2">
													{#if !welcome.acceptedGroupId}
														<Button
															type="button"
															size="sm"
															onclick={() => acceptWelcome(welcome.id)}
														>
															Accept
														</Button>
													{/if}
													{#if !welcome.readAt}
														<Button
															type="button"
															variant="outline"
															size="sm"
															onclick={() => markWelcomeNotificationRead(welcome.id)}
														>
															Mark read
														</Button>
													{/if}
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>
	</div>
</div>
