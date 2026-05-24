<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatGroupAvatar from '$lib/components/chat/ChatGroupAvatar.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import KeyPackageCard from '$lib/components/chat/KeyPackageCard.svelte';
	import { getChatGroupDisplayTitle } from '$lib/components/chat/chatGroupDisplay';
	import { matchesKeyPackageSearch } from '$lib/components/chat/keyPackageSearch';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
	import {
		getDefaultChatCoordinator,
		listChatCoordinators,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import {
		createChatGroup,
		inviteChatGroupMember,
		listChatGroupMembers,
		listChatGroups
	} from '$lib/services/chatGroups.svelte';
	import { createChatKeyPackage, listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
	import type { StoredCoordinator } from '$lib/services/chatCoordinators.svelte';
	import {
		coordinatorDetailsActionsStore,
		loadCoordinatorRemoteKeyPackagesAction
	} from '$lib/services/chatUiActions.svelte';
	import { getLatestChatGroupMessagePreview } from '$lib/services/chatGroupPresence.svelte';
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { goto } from '$app/navigation';
	import { eventStore } from '$lib/services/eventStore';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import CircleCheckBig from '@lucide/svelte/icons/circle-check-big';
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Server from '@lucide/svelte/icons/server';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import X from '@lucide/svelte/icons/x';
	import { ProfileModel } from 'applesauce-core/models';
	import { Metadata } from 'nostr-tools/kinds';

	const coordinators = $derived.by(() => listChatCoordinators());
	const groups = $derived.by(() => listChatGroups());
	const sortedGroups = $derived.by(() =>
		[...groups].sort((a, b) => getGroupActivityAt(b) - getGroupActivityAt(a))
	);
	const keyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const remoteKeyPackages = $derived.by(() =>
		coordinatorDetailsActionsStore.remoteKeyPackages.filter(
			(entry) => entry.pk !== $activeAccount?.pubkey
		)
	);
	const filteredRemoteKeyPackages = $derived.by(() =>
		remoteKeyPackages.filter((entry) =>
			matchesKeyPackageSearch({
				pubkey: entry.pk,
				keyPackageRef: entry.kp_ref,
				isLastResort: entry.last_resort,
				profileHints: keyPackageProfileHints,
				search: keyPackageDirectorySearch
			})
		)
	);
	const defaultCoordinator = $derived.by(() => getDefaultChatCoordinator());
	const hasAccount = $derived.by(() => Boolean($activeAccount));
	const hasCoordinator = $derived.by(() => coordinators.length > 0);
	const hasKeyPackages = $derived.by(() => keyPackages.length > 0);
	const hasGroups = $derived.by(() => groups.length > 0);
	const latestGroup = $derived.by(() => sortedGroups.at(0));
	const pendingOnboardingSteps = $derived.by(() =>
		onboardingSteps.filter((step) => !step.complete)
	);
	const completedOnboardingSteps = $derived.by(() =>
		onboardingSteps.filter((step) => step.complete)
	);
	const showSetupGuide = $derived.by(
		() => !setupGuideDismissed && pendingOnboardingSteps.length > 0
	);
	const onboardingSteps = $derived.by(() => [
		{
			title: 'Connect an account',
			description: 'Use your Nostr identity so Cordn can create key packages and groups.',
			complete: hasAccount
		},
		{
			title: 'Bootstrap messaging',
			description:
				'Use the default coordinator and publish one last-resort key package so people can invite you.',
			complete: hasCoordinator && hasKeyPackages
		},
		{
			title: 'Create your first group',
			description: 'Start a group once your identity, coordinator, and key package are ready.',
			complete: hasGroups
		}
	]);

	let completedStepsExpanded = $state(false);
	let setupGuideDismissed = $state(false);
	let settingDefaultCoordinator = $state(false);
	let keyPackageActionError = $state('');
	let creatingKeyPackage = $state(false);
	let bootstrapAdvancedOpen = $state(false);
	let quickChatError = $state('');
	let quickChatStartingRef = $state('');
	let keyPackageDirectoryLoaded = $state(false);
	let keyPackageDirectorySearch = $state('');
	let keyPackageProfileHints = $state<
		Record<string, { name?: string; displayName?: string; nip05?: string }>
	>({});

	function getCoordinatorLabel(coordinator: StoredCoordinator | undefined) {
		if (!coordinator) return 'No default coordinator yet';
		return coordinator.label || `Coordinator ${coordinator.pubkey.slice(0, 8)}`;
	}

	async function addDefaultCoordinator() {
		try {
			settingDefaultCoordinator = true;
			keyPackageActionError = '';
			upsertChatCoordinator({
				pubkey: DEFAULT_CHAT_COORDINATOR_PUBKEY,
				label: 'Default coordinator',
				isDefault: true
			});
		} catch (error) {
			keyPackageActionError =
				error instanceof Error ? error.message : 'Failed to save the default coordinator';
		} finally {
			settingDefaultCoordinator = false;
		}
	}

	async function bootstrapCoordinatorAndKeyPackage() {
		try {
			settingDefaultCoordinator = true;
			creatingKeyPackage = true;
			keyPackageActionError = '';

			if (!defaultCoordinator) {
				upsertChatCoordinator({
					pubkey: DEFAULT_CHAT_COORDINATOR_PUBKEY,
					label: 'Default coordinator',
					isDefault: true
				});
			}

			await createChatKeyPackage({
				isLastResort: true,
				publishCoordinatorKey: defaultCoordinator?.pubkey ?? DEFAULT_CHAT_COORDINATOR_PUBKEY
			});
		} catch (error) {
			keyPackageActionError = error instanceof Error ? error.message : 'Failed to finish bootstrap';
		} finally {
			settingDefaultCoordinator = false;
			creatingKeyPackage = false;
		}
	}

	async function createAndPublishKeyPackage() {
		const coordinatorKey = defaultCoordinator?.pubkey;

		if (!coordinatorKey) {
			keyPackageActionError = 'Set a default coordinator before creating a key package';
			return;
		}

		try {
			creatingKeyPackage = true;
			keyPackageActionError = '';
			await createChatKeyPackage({
				publishCoordinatorKey: coordinatorKey
			});
		} catch (error) {
			keyPackageActionError =
				error instanceof Error ? error.message : 'Failed to create and publish key package';
		} finally {
			creatingKeyPackage = false;
		}
	}

	function getGroupHref(groupId: string) {
		return resolve('/chat/[id]', { id: groupId });
	}

	function getGroupActivityAt(group: (typeof groups)[number]) {
		return Math.max(group.createdAt, group.messages.at(-1)?.createdAt ?? 0);
	}

	function getGroupTitle(group: (typeof groups)[number]) {
		return getChatGroupDisplayTitle({
			group,
			activePubkey: $activeAccount?.pubkey,
			profileHints: keyPackageProfileHints,
			memberPubkeys: listChatGroupMembers(group.id).map((member) => member.stablePubkey)
		});
	}

	function getGroupPreview(groupId: string) {
		return getLatestChatGroupMessagePreview(groupId);
	}

	function getRemoteKeyPackageCoordinatorLabel() {
		return coordinatorDetailsActionsStore.coordinatorKey
			? getCoordinatorLabel(
					coordinators.find(
						(entry) => entry.pubkey === coordinatorDetailsActionsStore.coordinatorKey
					)
				)
			: 'All known coordinators';
	}

	async function refreshKeyPackageDirectory() {
		keyPackageDirectoryLoaded = true;
		await loadCoordinatorRemoteKeyPackagesAction(undefined, { force: true });
	}

	async function loadKeyPackageDirectory() {
		keyPackageDirectoryLoaded = true;
		await loadCoordinatorRemoteKeyPackagesAction(undefined);
	}

	$effect(() => {
		const uniquePubkeys = [...new Set(remoteKeyPackages.map((entry) => entry.pk))];
		const subscriptions = uniquePubkeys.flatMap((pubkey) => [
			addressLoader({
				kind: Metadata,
				pubkey,
				relays: metadataRelays
			}).subscribe(),
			eventStore.model(ProfileModel, pubkey).subscribe((profile) => {
				const current = untrack(() => keyPackageProfileHints[pubkey]);
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

				keyPackageProfileHints = {
					...untrack(() => keyPackageProfileHints),
					[pubkey]: next
				};
			})
		]);

		return () => subscriptions.forEach((subscription) => subscription.unsubscribe());
	});

	$effect(() => {
		if ($activeAccount && coordinators.length > 0 && !keyPackageDirectoryLoaded) {
			void loadKeyPackageDirectory();
		}
	});

	async function startChatWithKeyPackage(keyPackage: (typeof remoteKeyPackages)[number]) {
		const coordinatorKey = defaultCoordinator?.pubkey ?? coordinators[0]?.pubkey;
		if (!coordinatorKey) {
			quickChatError = 'Add a coordinator before starting a chat';
			return;
		}

		try {
			quickChatStartingRef = keyPackage.kp_ref;
			quickChatError = '';
			const group = await createChatGroup({
				name: '',
				coordinatorKey,
				keyPackageIsLastResort: true
			});
			await inviteChatGroupMember({
				groupId: group.id,
				identifier: keyPackage.kp_ref
			});
			await goto(getGroupHref(group.id));
		} catch (error) {
			quickChatError = error instanceof Error ? error.message : 'Failed to start chat';
		} finally {
			quickChatStartingRef = '';
		}
	}

	function dismissSetupGuide() {
		setupGuideDismissed = true;
	}

	function toggleCompletedSteps() {
		completedStepsExpanded = !completedStepsExpanded;
	}
</script>

<svelte:head>
	<title>Chat home | Cordn</title>
	<meta
		name="description"
		content="Cordn chat onboarding and dashboard for coordinators, key packages, and groups."
	/>
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-4 backdrop-blur md:px-6">
		<div class="mx-auto flex w-full max-w-6xl flex-col gap-4">
			<div class="flex items-start gap-3">
				<ChatMobileSidebarButton />
				<div
					class="flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-card"
				>
					<Sparkles class="size-5" />
				</div>
				<div class="space-y-1">
					<h1 class="text-xl font-semibold tracking-tight">Chat home</h1>
				</div>
			</div>
			{#if hasGroups && latestGroup}
				<Button
					href={resolve('/chat/[id]', { id: latestGroup.id })}
					variant="outline"
					class="w-full sm:w-fit"
				>
					Open latest group
				</Button>
			{/if}
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto flex max-w-6xl flex-col gap-6">
			{#if showSetupGuide}
				<Card.Root>
					<Card.Header class="flex flex-row items-start justify-between gap-4 space-y-0">
						<div class="space-y-1.5">
							<Card.Title>Setup guide</Card.Title>
							<Card.Description>
								Finish the remaining steps to get your Cordn chat ready.
							</Card.Description>
						</div>
						<Button
							variant="ghost"
							size="icon"
							onclick={dismissSetupGuide}
							aria-label="Hide setup guide"
						>
							<X class="size-4" />
						</Button>
					</Card.Header>
					<Card.Content class="space-y-4">
						<div class="space-y-3">
							{#each pendingOnboardingSteps as step, index (step.title)}
								<div class="rounded-2xl border border-border p-4">
									<div class="flex items-start gap-3">
										<CircleDashed class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
										<div class="min-w-0 flex-1 space-y-3">
											<div class="space-y-1">
												<div class="flex items-center gap-2">
													<p class="font-medium">{index + 1}. {step.title}</p>
													<span
														class="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
													>
														Pending
													</span>
												</div>
												<p class="text-sm text-muted-foreground">{step.description}</p>
											</div>

											{#if step.title === 'Connect an account'}
												<div>
													<AccountLoginDialog />
												</div>
											{:else if step.title === 'Bootstrap messaging'}
												<div class="space-y-3">
													<div
														class="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
													>
														One action saves the default coordinator and publishes a last-resort key
														package for inbound welcomes.
													</div>
													{#if keyPackageActionError}
														<p class="text-sm text-destructive">{keyPackageActionError}</p>
													{/if}
													<div class="flex flex-wrap gap-2">
														<Button
															onclick={bootstrapCoordinatorAndKeyPackage}
															disabled={creatingKeyPackage ||
																settingDefaultCoordinator ||
																!hasAccount}
														>
															{creatingKeyPackage ? 'Bootstrapping…' : 'Use recommended setup'}
														</Button>
													</div>
													<div class="rounded-xl border border-border p-3">
														<button
															type="button"
															class="flex w-full items-center justify-between gap-3 text-left text-sm font-medium"
															onclick={() => (bootstrapAdvancedOpen = !bootstrapAdvancedOpen)}
														>
															<span>Advanced options</span>
															{#if bootstrapAdvancedOpen}<ChevronUp
																	class="size-4"
																/>{:else}<ChevronDown class="size-4" />{/if}
														</button>
														{#if bootstrapAdvancedOpen}
															<div class="mt-3 flex flex-wrap gap-2">
																<Button
																	onclick={addDefaultCoordinator}
																	disabled={settingDefaultCoordinator}
																	variant="outline"
																>
																	{settingDefaultCoordinator
																		? 'Saving…'
																		: 'Use default coordinator'}
																</Button>
																<Button
																	onclick={createAndPublishKeyPackage}
																	disabled={creatingKeyPackage || !defaultCoordinator}
																	variant="outline"
																>
																	{creatingKeyPackage ? 'Creating…' : 'Create regular key package'}
																</Button>
																<Button href={resolve('/chat/coordinators')} variant="ghost"
																	>Open coordinators</Button
																>
																<Button href={resolve('/chat/config/key-packages')} variant="ghost"
																	>Manage key packages</Button
																>
															</div>
														{/if}
													</div>
												</div>
											{:else if step.title === 'Create your first group'}
												<div class="flex flex-wrap gap-2">
													<Button href={resolve('/chat/create-group')}>Create group</Button>
												</div>
											{/if}
										</div>
									</div>
								</div>
							{/each}
						</div>

						{#if completedOnboardingSteps.length > 0}
							<div class="rounded-2xl border border-dashed border-border p-4">
								<button
									type="button"
									class="flex w-full items-center justify-between gap-3 text-left"
									onclick={toggleCompletedSteps}
								>
									<div>
										<p class="font-medium">Completed actions</p>
										<p class="text-sm text-muted-foreground">
											{completedOnboardingSteps.length} finished step{completedOnboardingSteps.length ===
											1
												? ''
												: 's'}
										</p>
									</div>
									{#if completedStepsExpanded}
										<ChevronUp class="size-4 shrink-0 text-muted-foreground" />
									{:else}
										<ChevronDown class="size-4 shrink-0 text-muted-foreground" />
									{/if}
								</button>

								{#if completedStepsExpanded}
									<div class="mt-4 space-y-3">
										{#each completedOnboardingSteps as step (step.title)}
											<div
												class="flex items-start gap-3 rounded-xl border border-border bg-muted/30 p-3"
											>
												<CircleCheckBig
													class="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
												/>
												<div>
													<p class="font-medium">{step.title}</p>
													<p class="text-sm text-muted-foreground">{step.description}</p>
												</div>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			{/if}

			<div class="flex flex-col gap-6">
				<Card.Root>
					<Card.Header>
						<Card.Title>Groups</Card.Title>
						<Card.Description>
							Open recent groups first, with the same visual preview used in the sidebar.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-4">
						{#if hasGroups}
							<div class="space-y-3">
								{#each sortedGroups as group (group.id)}
									<a
										href={getGroupHref(group.id)}
										class="group flex items-center gap-3 rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30"
									>
										<ChatGroupAvatar
											{group}
											class="h-12 w-12"
											fallbackClass="text-base font-medium"
										/>
										<div class="min-w-0 flex-1 space-y-1">
											<div class="flex items-center gap-2">
												<p class="truncate font-medium text-foreground">{getGroupTitle(group)}</p>
												{#if group.metadata?.description}
													<span class="hidden text-xs text-muted-foreground sm:inline">•</span>
													<p class="hidden truncate text-xs text-muted-foreground sm:block">
														{group.metadata.description}
													</p>
												{/if}
											</div>
											<p class="truncate text-sm text-muted-foreground">
												{getGroupPreview(group.id)}
											</p>
										</div>
										<ExternalLink
											class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
										/>
									</a>
								{/each}
							</div>
						{:else}
							<div
								class="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground"
							>
								No groups yet. Create one after your account, coordinator, and key package are
								ready.
							</div>
						{/if}
					</Card.Content>
					<Card.Footer class="pt-0">
						<Button
							href={resolve('/chat/create-group')}
							variant={hasGroups ? 'outline' : 'default'}
						>
							Create group
						</Button>
					</Card.Footer>
				</Card.Root>

				<Card.Root>
					<Card.Header class="flex flex-row items-start justify-between gap-4 space-y-0">
						<div class="space-y-1.5">
							<Card.Title>Available key packages</Card.Title>
							<Card.Description>
								Directory of public key packages in {getRemoteKeyPackageCoordinatorLabel()}.
							</Card.Description>
						</div>
						<Button
							onclick={refreshKeyPackageDirectory}
							disabled={coordinatorDetailsActionsStore.loadingKeyPackages}
							variant="outline"
						>
							{coordinatorDetailsActionsStore.loadingKeyPackages ? 'Refreshing…' : 'Refresh'}
						</Button>
					</Card.Header>
					<Card.Content class="space-y-3">
						{#if quickChatError}
							<p class="text-sm text-destructive">{quickChatError}</p>
						{/if}
						{#if coordinatorDetailsActionsStore.keyPackageError}
							<p class="text-sm text-destructive">
								{coordinatorDetailsActionsStore.keyPackageError}
							</p>
						{/if}
						<Input
							bind:value={keyPackageDirectorySearch}
							placeholder="Search by pubkey, package reference, or last resort"
							aria-label="Search available key packages"
						/>
						{#if !$activeAccount}
							<div
								class="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground"
							>
								Log in to browse coordinator key packages.
							</div>
						{:else if filteredRemoteKeyPackages.length > 0}
							<div class="space-y-3">
								{#each filteredRemoteKeyPackages as keyPackage (keyPackage.kp_ref)}
									<KeyPackageCard
										entry={keyPackage}
										actionLabel={quickChatStartingRef === keyPackage.kp_ref
											? 'Starting…'
											: 'Start chat'}
										actionDisabled={quickChatStartingRef === keyPackage.kp_ref}
										onAction={() => startChatWithKeyPackage(keyPackage)}
										class="bg-muted/20"
									/>
								{/each}
							</div>
						{:else if remoteKeyPackages.length > 0}
							<div
								class="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground"
							>
								No key packages match your search.
							</div>
						{:else}
							<div
								class="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground"
							>
								No public key packages found yet. Refresh after adding coordinators.
							</div>
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header class="space-y-1">
						<Card.Description>Configuration shortcuts</Card.Description>
						<Card.Title>Coordinators and key packages</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-4">
						<div class="flex flex-col gap-4">
							<a
								href={resolve('/chat/coordinators')}
								class="group rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30"
							>
								<div class="flex items-start justify-between gap-3">
									<div class="space-y-1">
										<div class="flex items-center gap-2 text-sm text-muted-foreground">
											<Server class="size-4" />
											<span>Coordinators</span>
										</div>
										<p class="text-2xl font-semibold text-foreground">{coordinators.length}</p>
										<p class="text-sm text-muted-foreground">
											Default: {getCoordinatorLabel(defaultCoordinator)}
										</p>
									</div>
									<ExternalLink
										class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
									/>
								</div>
							</a>

							<a
								href={resolve('/chat/config/key-packages')}
								class="group rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30"
							>
								<div class="flex items-start justify-between gap-3">
									<div class="space-y-1">
										<div class="flex items-center gap-2 text-sm text-muted-foreground">
											<KeyRound class="size-4" />
											<span>Your key packages</span>
										</div>
										<p class="text-2xl font-semibold text-foreground">{keyPackages.length}</p>
										<p class="text-sm text-muted-foreground">
											Manage local packages used to receive welcomes.
										</p>
									</div>
									<ExternalLink
										class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
									/>
								</div>
							</a>
						</div>
					</Card.Content>
				</Card.Root>
			</div>
		</div>
	</div>
</div>
