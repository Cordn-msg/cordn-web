<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import KeyPackageCard from '$lib/components/chat/KeyPackageCard.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { resolve } from '$app/paths';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { DEFAULT_CHAT_COORDINATOR_PUBKEY } from '$lib/constants/chat';
	import {
		getDefaultChatCoordinator,
		listChatCoordinators,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import {
		listChatKeyPackages,
		type StoredKeyPackageRecord
	} from '$lib/services/chatKeyPackages.svelte';
	import type { StoredCoordinator } from '$lib/services/chatCoordinators.svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import CircleCheckBig from '@lucide/svelte/icons/circle-check-big';
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Server from '@lucide/svelte/icons/server';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import X from '@lucide/svelte/icons/x';

	const coordinators = $derived.by(() => listChatCoordinators());
	const groups = $derived.by(() => listChatGroups());
	const keyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const defaultCoordinator = $derived.by(() => getDefaultChatCoordinator());
	const hasAccount = $derived.by(() => Boolean($activeAccount));
	const hasCoordinator = $derived.by(() => coordinators.length > 0);
	const hasKeyPackages = $derived.by(() => keyPackages.length > 0);
	const hasGroups = $derived.by(() => groups.length > 0);
	const latestGroup = $derived.by(() => groups.at(-1));
	const keyPackagesByCoordinator = $derived.by(() => {
		const grouped: Record<string, StoredKeyPackageRecord[]> = {};

		for (const keyPackage of keyPackages) {
			for (const coordinatorKey of keyPackage.publishedCoordinatorKeys) {
				grouped[coordinatorKey] = [...(grouped[coordinatorKey] ?? []), keyPackage];
			}
		}

		return grouped;
	});

	function getCoordinatorKeyPackages(coordinatorKey: string) {
		return keyPackagesByCoordinator[coordinatorKey] ?? [];
	}
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
			title: 'Save a coordinator',
			description:
				'Add a coordinator profile so the client knows where to publish and inspect state.',
			complete: hasCoordinator
		},
		{
			title: 'Create a key package',
			description: 'Generate at least one MLS key package for invitations and welcomes.',
			complete: hasKeyPackages
		},
		{
			title: 'Create your first group',
			description: 'Start a group once your identity, coordinator, and key package are ready.',
			complete: hasGroups
		}
	]);

	let coordinatorSetupError = $state('');
	let completedStepsExpanded = $state(false);
	let setupGuideDismissed = $state(false);
	let settingDefaultCoordinator = $state(false);

	function getCoordinatorLabel(coordinator: StoredCoordinator | undefined) {
		if (!coordinator) return 'No default coordinator yet';
		return coordinator.label || `Coordinator ${coordinator.pubkey.slice(0, 8)}`;
	}

	async function addDefaultCoordinator() {
		try {
			settingDefaultCoordinator = true;
			coordinatorSetupError = '';
			upsertChatCoordinator({
				pubkey: DEFAULT_CHAT_COORDINATOR_PUBKEY,
				label: 'Default coordinator',
				isDefault: true
			});
		} catch (error) {
			coordinatorSetupError =
				error instanceof Error ? error.message : 'Failed to save the default coordinator';
		} finally {
			settingDefaultCoordinator = false;
		}
	}

	function getGroupHref(groupId: string) {
		return resolve('/chat/[id]', { id: groupId });
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
		<div class="mx-auto flex w-full max-w-6xl items-start justify-between gap-4">
			<div class="flex items-start gap-3">
				<div
					class="flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-card"
				>
					<Sparkles class="size-5" />
				</div>
				<div class="space-y-1">
					<h1 class="text-xl font-semibold tracking-tight">Chat home</h1>
					<p class="max-w-2xl text-sm text-muted-foreground">
						Use this space to finish setup quickly and keep a clear view of your Cordn coordinators,
						key packages, and groups.
					</p>
				</div>
			</div>
			{#if hasGroups && latestGroup}
				<Button href={resolve('/chat/[id]', { id: latestGroup.id })} variant="outline">
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
											{:else if step.title === 'Save a coordinator'}
												<div class="space-y-3">
													<div
														class="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
													>
														Use the default coordinator or open the coordinator settings to manage
														others.
													</div>
													<p class="font-mono text-xs break-all text-muted-foreground">
														{DEFAULT_CHAT_COORDINATOR_PUBKEY}
													</p>
													{#if coordinatorSetupError}
														<p class="text-sm text-destructive">{coordinatorSetupError}</p>
													{/if}
													<div class="flex flex-wrap gap-2">
														<Button
															onclick={addDefaultCoordinator}
															disabled={settingDefaultCoordinator}
														>
															{settingDefaultCoordinator ? 'Saving…' : 'Use default coordinator'}
														</Button>
														<Button href="./coordinators" variant="outline">
															Open coordinators
														</Button>
													</div>
												</div>
											{:else if step.title === 'Create a key package'}
												<div class="flex flex-wrap gap-2">
													<Button href="./config/key-packages">Open key packages</Button>
												</div>
											{:else if step.title === 'Create your first group'}
												<div class="flex flex-wrap gap-2">
													<Button href="./create-group">Create group</Button>
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

			<div class="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
				<Card.Root>
					<Card.Header class="space-y-1">
						<Card.Description>Configuration shortcuts</Card.Description>
						<Card.Title>Coordinators and key packages</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-4">
						<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
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
											<span>Key packages</span>
										</div>
										<p class="text-2xl font-semibold text-foreground">{keyPackages.length}</p>
										<p class="text-sm text-muted-foreground">
											{hasKeyPackages
												? 'Open your key package inventory and publish more when needed.'
												: 'Create your first key package to receive welcomes.'}
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

				<Card.Root>
					<Card.Header>
						<Card.Title>Groups</Card.Title>
						<Card.Description>
							Open an existing group directly from here or create a new one.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-4">
						{#if hasGroups}
							<div class="space-y-3">
								{#each [...groups].reverse() as group (group.id)}
									<a
										href={getGroupHref(group.id)}
										class="group block rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30"
									>
										<div class="flex items-start justify-between gap-3">
											<div class="min-w-0 space-y-1">
												<div class="flex items-center gap-2 text-sm text-muted-foreground">
													<MessageSquare class="size-4" />
													<span>{group.metadata?.name ?? group.id ?? 'Untitled group'}</span>
												</div>
												<p class="font-mono text-xs break-all text-muted-foreground">{group.id}</p>
												<p class="text-sm text-muted-foreground">
													Created {new Date(group.createdAt).toLocaleString()}
												</p>
											</div>
											<ExternalLink
												class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
											/>
										</div>
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
						<Button href="./create-group" variant={hasGroups ? 'outline' : 'default'}>
							Create group
						</Button>
					</Card.Footer>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Available key packages by coordinator</Card.Title>
						<Card.Description>
							See which coordinators already have local key packages assigned.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						{#if coordinators.length > 0}
							{#each coordinators as coordinator (coordinator.pubkey)}
								{@const coordinatorKeyPackages = getCoordinatorKeyPackages(coordinator.pubkey)}
								<div class="rounded-xl border border-border px-4 py-3">
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0 space-y-2">
											<p class="font-medium text-foreground">{getCoordinatorLabel(coordinator)}</p>
											<ProfileCard pubkey={coordinator.pubkey} />
										</div>
										<span
											class="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
										>
											{coordinatorKeyPackages.length} key package{coordinatorKeyPackages.length ===
											1
												? ''
												: 's'}
										</span>
									</div>
									{#if coordinatorKeyPackages.length > 0}
										<div class="mt-3 space-y-2">
											{#each coordinatorKeyPackages as keyPackage (keyPackage.keyPackageRef)}
												<KeyPackageCard
													entry={keyPackage}
													compact={true}
													class="border-border/60 bg-muted/20"
												/>
											{/each}
										</div>
									{:else}
										<div
											class="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
										>
											No local key packages published here yet.
										</div>
									{/if}
								</div>
							{/each}
						{:else}
							<div
								class="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground"
							>
								Add a coordinator first to start organizing key packages.
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			</div>
		</div>
	</div>
</div>
