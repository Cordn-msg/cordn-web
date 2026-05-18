<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getChatCoordinator,
		getCoordinatorColor,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { getChatGroup, listChatGroups } from '$lib/services/chatGroups.svelte';
	import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
	import {
		chatWelcomeNotificationsStore,
		listWelcomeNotificationsForCoordinator,
		markWelcomeNotificationRead
	} from '$lib/services/chatWelcomeNotifications.svelte';
	import {
		acceptWelcomeAction,
		coordinatorDetailsActionsStore,
		loadCoordinatorRemoteKeyPackagesAction,
		refreshCoordinatorWelcomeNotificationsAction
	} from '$lib/services/chatUiActions.svelte';
	import { getCoordinatorClient, requireActiveAccount } from '$lib/services/chatRuntime';
	import { normalizePubKey } from '$lib/utils';
	import Boxes from '@lucide/svelte/icons/boxes';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Server from '@lucide/svelte/icons/server';

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
	const remoteKeyPackages = $derived.by(() => coordinatorDetailsActionsStore.remoteKeyPackages);
	const ownedRemoteKeyPackages = $derived.by(() =>
		remoteKeyPackages.filter((entry) => normalizePubKey(entry.pk) === activePubkey)
	);
	const otherRemoteKeyPackages = $derived.by(() =>
		remoteKeyPackages.filter((entry) => normalizePubKey(entry.pk) !== activePubkey)
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

	async function loadRemoteKeyPackages() {
		await loadCoordinatorRemoteKeyPackagesAction(
			getCoordinatorClient(
				requireActiveAccount('You must be logged in to inspect coordinators'),
				coordinatorKey
			)
		);
	}

	async function loadPendingWelcomes() {
		await refreshCoordinatorWelcomeNotificationsAction(coordinatorKey);
	}

	function storeCoordinator() {
		upsertChatCoordinator({ pubkey: coordinatorKey });
	}

	function getAcceptedGroupLabel(groupId: string) {
		const group = getChatGroup(groupId);
		return group?.metadata?.name || group?.alias || 'Joined group';
	}

	async function acceptWelcome(welcomeId: string) {
		await acceptWelcomeAction(welcomeId);
	}
</script>

<svelte:head>
	<title>{coordinator?.label || 'Coordinator'} | Cordn</title>
	<meta name="description" content="Coordinator detail workspace for Cordn." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Server class="size-4" />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">
					{coordinator?.label || `Coordinator ${coordinatorKey.slice(0, 8)}`}
				</h1>
				<p class="text-sm break-all text-muted-foreground">{coordinatorKey}</p>
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
									<p class="mt-1 font-mono text-xs break-all">{coordinatorKey}</p>
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
						<Button href="/chat/coordinators" variant="outline">Back to coordinators</Button>
						<Button href={`/chat/create-group?coordinator=${coordinatorKey}`}
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
										href={`/chat/${group.id}`}
										class="block rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/40"
									>
										<p class="font-medium">{group.metadata?.name || group.alias}</p>
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
									<div class="rounded-xl border border-border px-4 py-3">
										<p class="font-medium">{keyPackage.label}</p>
										<p class="mt-1 font-mono text-xs break-all text-muted-foreground">
											{keyPackage.keyPackageRef}
										</p>
									</div>
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
										{#each ownedRemoteKeyPackagesWithState as item (item.entry.kp_ref)}
											<div class="rounded-xl border border-border px-4 py-3">
												<div class="flex items-center justify-between gap-3">
													<div>
														<p class="font-medium">
															{item.localCopy?.label || 'Remote owned key package'}
														</p>
														<p class="font-mono text-xs break-all text-muted-foreground">
															{item.entry.kp_ref}
														</p>
													</div>
													<span
														class={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.localCopy ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}
													>
														{item.state}
													</span>
												</div>
												<div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
													{#if item.entry.last_resort}
														<CircleAlert class="size-3" />
														<span>Last resort</span>
													{/if}
													<span>{new Date(item.entry.at).toLocaleString()}</span>
												</div>
											</div>
										{/each}
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
								{#each otherRemoteKeyPackages as entry (entry.kp_ref)}
									<div class="rounded-xl border border-border px-4 py-3">
										<p class="font-mono text-xs break-all text-muted-foreground">
											Owner {entry.pk}
										</p>
										<p class="mt-1 font-mono text-xs break-all">{entry.kp_ref}</p>
										<div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
											{#if entry.last_resort}
												<CircleAlert class="size-3" />
												<span>Last resort</span>
											{/if}
											<span>{new Date(entry.at).toLocaleString()}</span>
										</div>
									</div>
								{/each}
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
												<div>
													<p class="font-medium">Welcome for key package</p>
													<p class="mt-1 font-mono text-xs break-all text-muted-foreground">
														{welcome.kpRef}
													</p>
													<p class="mt-2 text-xs text-muted-foreground">
														{new Date(welcome.at).toLocaleString()}
													</p>
													{#if welcome.acceptedGroupId}
														<p class="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
															Accepted into {getAcceptedGroupLabel(welcome.acceptedGroupId)}
														</p>
													{/if}
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
