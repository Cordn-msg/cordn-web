<script lang="ts">
	import { browser } from '$app/environment';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChatActionIcons from '$lib/components/chat/ChatActionIcons.svelte';
	import ChatGroupListItem from '$lib/components/chat/ChatGroupListItem.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import AvailableKeyPackageDirectory from '$lib/components/chat/AvailableKeyPackageDirectory.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
	import {
		getCoordinatorLabel,
		getDefaultChatCoordinator,
		listChatCoordinators,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import NewsListItem from '$lib/components/news/NewsListItem.svelte';
	import { getUnreadNewsCount, hasUnreadNews } from '$lib/news/newsReadState.svelte';
	import {
		createChatKeyPackage,
		ensureLastResortPublished,
		listChatKeyPackages
	} from '$lib/services/chatKeyPackages.svelte';
	import { promptForeignLastResort } from '$lib/services/lastResortConflict.svelte';
	import {
		useAvailableKeyPackages,
		type AvailableKeyPackageWithCoordinator
	} from '$lib/queries/chatKeyPackageQueries';
	import {
		refreshAvailableKeyPackagesAction,
		startChatWithKeyPackageAction
	} from '$lib/services/chatUiActions.svelte';
	import { getChatGroupSummary } from '$lib/services/chatGroupPresence.svelte';
	import { goto } from '$app/navigation';
	import { getGroupActivityAt } from '$lib/components/chat/chatGroupDisplay';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import CircleCheckBig from '@lucide/svelte/icons/circle-check-big';
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Server from '@lucide/svelte/icons/server';
	import X from '@lucide/svelte/icons/x';

	const coordinators = $derived.by(() => listChatCoordinators());
	const groups = $derived.by(() => listChatGroups());
	const sortedGroups = $derived.by(() =>
		[...groups].sort((a, b) => getGroupActivityAt(b) - getGroupActivityAt(a))
	);
	const newsUnreadCount = $derived.by(() => getUnreadNewsCount());
	const newsHasUnread = $derived.by(() => hasUnreadNews());
	const keyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	// Read for the header Refresh button's loading state; the directory itself
	// reads the same shared query inside AvailableKeyPackageDirectory.
	const availableKeyPackagesQuery = useAvailableKeyPackages(() => $activeAccount?.pubkey);
	const defaultCoordinator = $derived.by(() => getDefaultChatCoordinator());
	const hasAccount = $derived.by(() => Boolean($activeAccount));
	const hasCoordinator = $derived.by(() => coordinators.length > 0);
	const hasKeyPackages = $derived.by(() => keyPackages.length > 0);
	const hasGroups = $derived.by(() => groups.length > 0);
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
	let setupGuideDismissed = $state(
		browser ? localStorage.getItem('cordn.setupGuideDismissed') === '1' : false
	);
	let settingDefaultCoordinator = $state(false);
	let keyPackageActionError = $state('');
	let creatingKeyPackage = $state(false);
	let bootstrapAdvancedOpen = $state(false);
	let quickChatError = $state('');
	let quickChatStartingRef = $state('');

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

			const bootstrapResult = await ensureLastResortPublished(
				defaultCoordinator?.pubkey ?? DEFAULT_CHAT_COORDINATOR_PUBKEY
			);
			if (bootstrapResult.kind === 'foreign') {
				void promptForeignLastResort(bootstrapResult.coordinatorKey);
				return;
			}
		} catch (error) {
			keyPackageActionError = error instanceof Error ? error.message : 'Failed to finish bootstrap';
		} finally {
			settingDefaultCoordinator = false;
			creatingKeyPackage = false;
		}
	}

	async function createAndPublishKeyPackage(isLastResort = true) {
		const coordinatorKey = defaultCoordinator?.pubkey;

		if (!coordinatorKey) {
			keyPackageActionError = 'Set a default coordinator before creating a key package';
			return false;
		}

		try {
			creatingKeyPackage = true;
			keyPackageActionError = '';
			if (isLastResort) {
				const result = await ensureLastResortPublished(coordinatorKey);
				if (result.kind === 'foreign') {
					if (!(await promptForeignLastResort(result.coordinatorKey))) return false;
				}
				toast.success('Key package ready', {
					description: 'Last resort: always reachable for invites and join requests.'
				});
			} else {
				await createChatKeyPackage({
					isLastResort: false,
					publishCoordinatorKey: coordinatorKey
				});
				toast.success('Key package created', {
					description: 'Regular: consumed on first use.'
				});
			}
			return true;
		} catch (error) {
			keyPackageActionError =
				error instanceof Error ? error.message : 'Failed to create and publish key package';
			return false;
		} finally {
			creatingKeyPackage = false;
		}
	}

	function getGroupHref(groupId: string) {
		return resolve('/chat/[id]', { id: groupId });
	}

	function getNewsHref() {
		return resolve('/chat/news');
	}

	async function refreshKeyPackageDirectory() {
		await refreshAvailableKeyPackagesAction();
	}

	async function startChatWithKeyPackage(keyPackage: AvailableKeyPackageWithCoordinator) {
		if (!keyPackage.coordinatorKey) {
			quickChatError = 'Add a coordinator before starting a chat';
			return;
		}

		try {
			quickChatStartingRef = keyPackage.kp_ref;
			quickChatError = '';
			const groupId = await startChatWithKeyPackageAction(keyPackage);
			await goto(getGroupHref(groupId));
		} catch (error) {
			quickChatError = error instanceof Error ? error.message : 'Failed to start chat';
		} finally {
			quickChatStartingRef = '';
		}
	}

	function dismissSetupGuide() {
		setupGuideDismissed = true;
		if (browser) {
			localStorage.setItem('cordn.setupGuideDismissed', '1');
		}
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
				<div class="space-y-1">
					<h1 class="text-xl font-semibold tracking-tight">Chat home</h1>
				</div>
			</div>
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
															{#if creatingKeyPackage}
																<Spinner class="mr-2 size-4" />
															{/if}
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
																	{#if settingDefaultCoordinator}
																		<Spinner class="mr-2 size-4" />
																	{/if}
																	{settingDefaultCoordinator
																		? 'Saving…'
																		: 'Use default coordinator'}
																</Button>
																<Button
																	onclick={() => createAndPublishKeyPackage(false)}
																	disabled={creatingKeyPackage || !defaultCoordinator}
																	variant="outline"
																>
																	{#if creatingKeyPackage}
																		<Spinner class="mr-2 size-4" />
																	{/if}
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
				<ChatActionIcons />

				<Card.Root>
					<Card.Header>
						<Card.Title>Groups</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-4">
						{#if newsHasUnread}
							<NewsListItem href={getNewsHref()} variant="card" unreadCount={newsUnreadCount} />
						{/if}
						{#if hasGroups}
							<div class="space-y-3">
								{#each sortedGroups as group (group.id)}
									{@const summary = getChatGroupSummary(group.id, $activeAccount?.pubkey)}
									<ChatGroupListItem
										{group}
										href={getGroupHref(group.id)}
										preview={summary.preview}
										unreadCount={summary.unreadCount}
										unreadReferenceCount={summary.unreadReferenceCount}
									/>
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
						{#if !newsHasUnread}
							<NewsListItem href={getNewsHref()} variant="card" unreadCount={0} />
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
					<Card.Header class="flex flex-col items-start justify-between gap-4 space-y-0">
						<div class="space-y-1.5">
							<Card.Title>Available key packages</Card.Title>
							<Card.Description>
								Directory of public key packages in all known coordinators.
							</Card.Description>
						</div>
						<div class="flex flex-wrap justify-end gap-2">
							<div class="inline-flex">
								<Button
									onclick={() => createAndPublishKeyPackage(true)}
									disabled={creatingKeyPackage || !$activeAccount || !defaultCoordinator}
									variant="outline"
									class="rounded-r-none border-r-0"
								>
									{#if creatingKeyPackage}
										<Spinner class="mr-2 size-4" />
									{/if}
									{creatingKeyPackage ? 'Creating…' : 'Create key package'}
								</Button>
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												variant="outline"
												disabled={creatingKeyPackage || !$activeAccount || !defaultCoordinator}
												class="rounded-l-none px-2"
												aria-label="More key package options"
											>
												<ChevronDown class="size-4" />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item onSelect={() => createAndPublishKeyPackage(false)}>
											Regular key package
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</div>
							<Button
								onclick={refreshKeyPackageDirectory}
								disabled={availableKeyPackagesQuery.isFetching}
								variant="outline"
							>
								{#if availableKeyPackagesQuery.isFetching}
									<Spinner class="mr-2 size-4" />
								{/if}
								{availableKeyPackagesQuery.isFetching ? 'Refreshing…' : 'Refresh'}
							</Button>
						</div>
					</Card.Header>
					<Card.Content class="space-y-3">
						{#if keyPackageActionError}
							<p class="text-sm text-destructive">{keyPackageActionError}</p>
						{/if}
						{#if quickChatError}
							<p class="text-sm text-destructive">{quickChatError}</p>
						{/if}
						<AvailableKeyPackageDirectory
							onStartChat={startChatWithKeyPackage}
							startingRef={quickChatStartingRef}
							includeSelf
							showCount
							showCoordinatorFilter
							maxHeightClass="max-h-[32rem]"
							emptyMessage="No public key packages found yet. Refresh after adding coordinators."
						/>
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
											Default: {defaultCoordinator
												? getCoordinatorLabel(defaultCoordinator.pubkey)
												: 'No default coordinator yet'}
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
