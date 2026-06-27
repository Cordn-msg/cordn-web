<script lang="ts">
	import { resolve } from '$app/paths';
	import type { AvailableKeyPackage } from '$lib/contracts';
	import * as Card from '$lib/components/ui/card';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import KeyPackageCard from '$lib/components/chat/KeyPackageCard.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { fetchCoordinatorAvailableKeyPackages } from '$lib/queries/chatKeyPackageQueries';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		listChatGroups,
		pruneConsumedKeyPackagesForActiveGroups
	} from '$lib/services/chatGroups.svelte';
	import {
		createChatKeyPackage,
		listChatKeyPackages,
		listZombieKeyPackageRefs,
		publishChatKeyPackage,
		removeChatKeyPackage
	} from '$lib/services/chatKeyPackages.svelte';
	import { getCoordinatorLabel, listChatCoordinators } from '$lib/services/chatCoordinators.svelte';
	import { normalizePubKey } from '$lib/utils';
	import Boxes from '@lucide/svelte/icons/boxes';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { SvelteMap } from 'svelte/reactivity';

	type OwnedRemoteKeyPackage = AvailableKeyPackage & {
		coordinatorKey: string;
		localCopy: ReturnType<typeof listChatKeyPackages>[number] | undefined;
	};

	function getCoordinator(pubkey: string) {
		return coordinators.find((entry) => entry.pubkey === pubkey);
	}

	let loading = $state(false);
	let error = $state('');
	let label = $state('');
	let publishCoordinatorKey = $state('');
	let isLastResort = $state(false);
	let publishingKeyPackageRef = $state('');
	let removingKeyPackageRef = $state('');
	let loadingRemoteKeyPackages = $state(false);
	let remoteKeyPackagesLoaded = $state(false);
	let remoteKeyPackageError = $state('');
	let removingRemoteKey = $state('');
	let ownedRemoteKeyPackages = $state<OwnedRemoteKeyPackage[]>([]);

	const keyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const chatGroups = $derived.by(() => listChatGroups());
	const coordinators = $derived.by(() => listChatCoordinators());
	const activePubkey = $derived.by(() =>
		$activeAccount ? normalizePubKey($activeAccount.pubkey) : ''
	);
	const remoteKeyPackagesByCoordinator = $derived.by(() => {
		const groups = new SvelteMap<string, OwnedRemoteKeyPackage[]>();
		for (const entry of ownedRemoteKeyPackages) {
			const existing = groups.get(entry.coordinatorKey) ?? [];
			existing.push(entry);
			groups.set(entry.coordinatorKey, existing);
		}

		return [...groups.entries()]
			.map(([coordinatorKey, entries]) => ({
				coordinatorKey,
				label: getCoordinatorLabel(coordinatorKey),
				entries: [...entries].sort((a, b) => b.at - a.at)
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	});
	const orphanedRemoteKeyPackageCount = $derived.by(
		() => ownedRemoteKeyPackages.filter((entry) => !entry.localCopy).length
	);
	const localZombieKeyPackageCount = $derived.by(() => {
		const consumedRefs = chatGroups
			.map((group) => group.joinedWithKeyPackageRef)
			.filter((ref): ref is string => Boolean(ref));
		return listZombieKeyPackageRefs(consumedRefs).length;
	});

	async function handleCreate() {
		try {
			loading = true;
			error = '';
			await createChatKeyPackage({
				label,
				isLastResort,
				publishCoordinatorKey
			});
			label = '';
			publishCoordinatorKey = '';
			isLastResort = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create key package';
		} finally {
			loading = false;
		}
	}

	async function handlePublish(keyPackageRef: string, coordinatorKey: string) {
		try {
			publishingKeyPackageRef = keyPackageRef;
			error = '';
			await publishChatKeyPackage(keyPackageRef, coordinatorKey);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to publish key package';
		} finally {
			publishingKeyPackageRef = '';
		}
	}

	async function handleRemove(keyPackageRef: string) {
		try {
			removingKeyPackageRef = keyPackageRef;
			error = '';
			await removeChatKeyPackage(keyPackageRef);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to remove key package';
		} finally {
			removingKeyPackageRef = '';
		}
	}

	let pruningLocal = $state(false);
	async function handlePruneLocalZombies() {
		try {
			pruningLocal = true;
			error = '';
			await pruneConsumedKeyPackagesForActiveGroups();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to clean up key packages';
		} finally {
			pruningLocal = false;
		}
	}

	async function loadRemoteKeyPackages() {
		if (!$activeAccount) return;

		try {
			loadingRemoteKeyPackages = true;
			remoteKeyPackageError = '';

			const remoteResults = await Promise.all(
				coordinators.map(async (coordinator) => {
					const entries = await fetchCoordinatorAvailableKeyPackages(coordinator.pubkey, {
						force: remoteKeyPackagesLoaded
					});
					return entries
						.filter((entry) => normalizePubKey(entry.pk) === activePubkey)
						.map((entry) => ({
							...entry,
							coordinatorKey: normalizePubKey(coordinator.pubkey),
							localCopy: keyPackages.find((record) => record.keyPackageRef === entry.kp_ref)
						}));
				})
			);

			ownedRemoteKeyPackages = remoteResults.flat().sort((a, b) => b.at - a.at);
			remoteKeyPackagesLoaded = true;
		} catch (err) {
			remoteKeyPackageError =
				err instanceof Error ? err.message : 'Failed to load remote key packages';
		} finally {
			loadingRemoteKeyPackages = false;
		}
	}

	async function handleRemoveRemote(keyPackageRef: string, coordinatorKey: string) {
		try {
			removingRemoteKey = `${coordinatorKey}:${keyPackageRef}`;
			remoteKeyPackageError = '';
			await removeChatKeyPackage(keyPackageRef, { coordinatorKey });
			await loadRemoteKeyPackages();
		} catch (err) {
			remoteKeyPackageError =
				err instanceof Error ? err.message : 'Failed to remove remote key package';
		} finally {
			removingRemoteKey = '';
		}
	}
</script>

<svelte:head>
	<title>Key packages | Cordn</title>
	<meta name="description" content="Manage locally generated Cordn key packages." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<KeyRound class="size-4" />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">Key packages</h1>
				<p class="text-sm text-muted-foreground">
					Generate and inspect the MLS key packages available for your active identity.
				</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto grid max-w-4xl gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
			<Card.Root>
				<Card.Header>
					<Card.Title>Create key package</Card.Title>
					<Card.Description
						>Create a fresh MLS key package and persist it locally for later publishing.</Card.Description
					>
				</Card.Header>
				<Card.Content>
					{#if !$activeAccount}
						<div class="space-y-3">
							<p class="text-sm text-muted-foreground">
								Log in to create key packages for your active identity.
							</p>
							<AccountLoginDialog />
						</div>
					{:else}
						<div class="space-y-4">
							<InputGroup.Root>
								<InputGroup.Input bind:value={label} placeholder="Optional key package label" />
								<InputGroup.Addon>
									<InputGroup.Text>Label</InputGroup.Text>
								</InputGroup.Addon>
							</InputGroup.Root>

							<InputGroup.Root>
								<InputGroup.Input
									bind:value={publishCoordinatorKey}
									class="font-mono text-xs"
									placeholder="Optional publish coordinator pubkey"
								/>
								<InputGroup.Addon>
									<InputGroup.Text>Publish</InputGroup.Text>
								</InputGroup.Addon>
							</InputGroup.Root>

							{#if coordinators.length > 0}
								<div class="flex flex-wrap gap-2">
									{#each coordinators as coordinator (coordinator.pubkey)}
										<Button
											type="button"
											variant="outline"
											size="xs"
											onclick={() => (publishCoordinatorKey = coordinator.pubkey)}
										>
											{coordinator.label}
										</Button>
									{/each}
								</div>
							{/if}

							<label class="flex items-center gap-2 text-sm text-muted-foreground">
								<input
									bind:checked={isLastResort}
									type="checkbox"
									class="h-4 w-4 rounded border-border"
								/>
								Last resort key package
							</label>

							{#if error}
								<p class="text-sm text-destructive">{error}</p>
							{/if}

							<div class="flex justify-end">
								<Button type="button" onclick={handleCreate} disabled={loading}>
									{#if loading}
										<Spinner class="mr-2 size-4" />
									{/if}
									{loading ? 'Generating…' : 'Generate key package'}
								</Button>
							</div>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<div class="flex items-start justify-between gap-3">
						<div>
							<Card.Title>Stored key packages</Card.Title>
							<Card.Description>
								Local records for the active account, ordered newest first. Key packages only let
								others invite you in — removing one does not affect groups you have already joined.
							</Card.Description>
						</div>
						{#if localZombieKeyPackageCount > 0}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={pruningLocal}
								onclick={handlePruneLocalZombies}
							>
								<Trash2 class="mr-2 size-4" />
								{pruningLocal ? 'Cleaning…' : `Clean up ${localZombieKeyPackageCount} consumed`}
							</Button>
						{/if}
					</div>
				</Card.Header>
				<Card.Content>
					<div class="space-y-3">
						{#if !$activeAccount}
							<div
								class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
							>
								Log in to inspect saved key packages.
							</div>
						{:else if keyPackages.length === 0}
							<div
								class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
							>
								No key packages generated yet.
							</div>
						{:else}
							{#each keyPackages as keyPackage (keyPackage.keyPackageRef)}
								<div class="space-y-2 rounded-xl border border-border px-4 py-3">
									<KeyPackageCard entry={keyPackage} />
									<p class="text-xs text-muted-foreground">
										Published to {keyPackage.publishedCoordinatorKeys.length} coordinator{keyPackage
											.publishedCoordinatorKeys.length === 1
											? ''
											: 's'}
									</p>
									{#if keyPackage.publishedCoordinatorKeys.length > 0}
										<div class="space-y-2 pt-1">
											{#each keyPackage.publishedCoordinatorKeys as coordinatorKey (coordinatorKey)}
												<a
													href={resolve('/chat/coordinators/[coordinatorKey]', { coordinatorKey })}
													class="block rounded-lg border border-border/60 px-3 py-2 transition-colors hover:bg-background"
												>
													<div class="flex items-center justify-between gap-3">
														<div class="min-w-0">
															<p class="text-sm font-medium">
																{getCoordinatorLabel(coordinatorKey)}
															</p>
															<ProfileCard pubkey={coordinatorKey} />
														</div>
														{#if getCoordinator(coordinatorKey)?.isDefault}
															<span
																class="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground"
															>
																Default
															</span>
														{/if}
													</div>
												</a>
											{/each}
										</div>
									{/if}
									{#if coordinators.length > 0}
										<div class="flex flex-wrap gap-2 pt-1">
											{#each coordinators as coordinator (coordinator.pubkey)}
												<Button
													type="button"
													variant="outline"
													size="xs"
													disabled={publishingKeyPackageRef === keyPackage.keyPackageRef ||
														keyPackage.publishedCoordinatorKeys.includes(coordinator.pubkey)}
													onclick={() =>
														handlePublish(keyPackage.keyPackageRef, coordinator.pubkey)}
												>
													{keyPackage.publishedCoordinatorKeys.includes(coordinator.pubkey)
														? `Published: ${coordinator.label}`
														: `Publish to ${coordinator.label}`}
												</Button>
											{/each}
										</div>
									{/if}
									<div class="flex justify-end pt-1">
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={removingKeyPackageRef === keyPackage.keyPackageRef}
											onclick={() => handleRemove(keyPackage.keyPackageRef)}
										>
											<Trash2 class="mr-2 size-4" />
											{removingKeyPackageRef === keyPackage.keyPackageRef
												? 'Removing…'
												: 'Remove local + remote'}
										</Button>
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root class="lg:col-span-2">
				<Card.Header>
					<Card.Title>Remote coordinator key packages</Card.Title>
					<Card.Description
						>Inspect all key packages published for your active identity across saved coordinators,
						including orphaned remote entries with no local copy.</Card.Description
					>
				</Card.Header>
				<Card.Content>
					{#if !$activeAccount}
						<div class="space-y-3">
							<p class="text-sm text-muted-foreground">
								Log in to inspect coordinator-side key packages.
							</p>
							<AccountLoginDialog />
						</div>
					{:else if coordinators.length === 0}
						<div
							class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
						>
							Add a coordinator first to inspect published key packages.
						</div>
					{:else}
						<div class="space-y-4">
							<div class="flex flex-wrap items-center justify-between gap-3">
								<div class="text-sm text-muted-foreground">
									{#if remoteKeyPackagesLoaded}
										Found {ownedRemoteKeyPackages.length} remote key package{ownedRemoteKeyPackages.length ===
										1
											? ''
											: 's'} across {remoteKeyPackagesByCoordinator.length} coordinator{remoteKeyPackagesByCoordinator.length ===
										1
											? ''
											: 's'}.
										{#if orphanedRemoteKeyPackageCount > 0}
											<span class="ml-2 text-amber-600 dark:text-amber-400">
												{orphanedRemoteKeyPackageCount} orphaned
											</span>
										{/if}
									{:else}
										Load remote state to compare local storage with coordinator directories.
									{/if}
								</div>
								<Button
									type="button"
									onclick={loadRemoteKeyPackages}
									disabled={loadingRemoteKeyPackages}
								>
									{#if loadingRemoteKeyPackages}
										<Spinner class="mr-2 size-4" />
									{:else}
										<Boxes class="mr-2 size-4" />
									{/if}
									{loadingRemoteKeyPackages
										? 'Loading remote key packages…'
										: remoteKeyPackagesLoaded
											? 'Refresh remote key packages'
											: 'Load remote key packages'}
								</Button>
							</div>

							{#if remoteKeyPackageError}
								<p class="text-sm text-destructive">{remoteKeyPackageError}</p>
							{/if}

							{#if !remoteKeyPackagesLoaded}
								<div
									class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
								>
									Load remote key packages to inspect coordinator-side state and remove orphaned
									entries.
								</div>
							{:else if ownedRemoteKeyPackages.length === 0}
								<div
									class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
								>
									No remote key packages owned by the active identity were found on your saved
									coordinators.
								</div>
							{:else}
								<div class="space-y-4">
									{#each remoteKeyPackagesByCoordinator as group (group.coordinatorKey)}
										<div class="space-y-3 rounded-2xl border border-border p-4">
											<div class="flex items-center justify-between gap-3">
												<div class="min-w-0">
													<p class="font-medium">{group.label}</p>
													<p class="text-xs text-muted-foreground">
														{group.entries.length} owned key package{group.entries.length === 1
															? ''
															: 's'}
													</p>
												</div>
												<Button
													href={resolve('/chat/coordinators/[coordinatorKey]', {
														coordinatorKey: group.coordinatorKey
													})}
													variant="outline"
													size="sm"
												>
													Open coordinator
												</Button>
											</div>

											<div class="space-y-3">
												{#each group.entries as remoteEntry (remoteEntry.kp_ref)}
													<div class="space-y-2 rounded-xl border border-border/70 px-4 py-3">
														<KeyPackageCard
															entry={remoteEntry}
															badge={remoteEntry.localCopy
																? 'remote + local copy'
																: 'orphaned remote'}
														/>
														{#if remoteEntry.localCopy}
															<p class="text-xs text-muted-foreground">
																Local label: {remoteEntry.localCopy.label}
															</p>
														{:else}
															<p class="text-xs text-amber-600 dark:text-amber-400">
																This remote key package has no local record and can be cleaned up
																here.
															</p>
														{/if}
														<div class="flex justify-end pt-1">
															<Button
																type="button"
																variant="outline"
																size="sm"
																disabled={removingRemoteKey ===
																	`${remoteEntry.coordinatorKey}:${remoteEntry.kp_ref}`}
																onclick={() =>
																	handleRemoveRemote(
																		remoteEntry.kp_ref,
																		remoteEntry.coordinatorKey
																	)}
															>
																<Trash2 class="mr-2 size-4" />
																{removingRemoteKey ===
																`${remoteEntry.coordinatorKey}:${remoteEntry.kp_ref}`
																	? 'Removing…'
																	: remoteEntry.localCopy
																		? 'Remove remote entry'
																		: 'Remove orphaned remote'}
															</Button>
														</div>
													</div>
												{/each}
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
