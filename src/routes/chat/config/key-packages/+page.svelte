<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { Button } from '$lib/components/ui/button';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import KeyPackageCard from '$lib/components/chat/KeyPackageCard.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		createChatKeyPackage,
		listChatKeyPackages,
		publishChatKeyPackage,
		removeChatKeyPackage
	} from '$lib/services/chatKeyPackages.svelte';
	import { listChatCoordinators } from '$lib/services/chatCoordinators.svelte';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	function getCoordinatorHref(coordinatorKey: string) {
		return `../../coordinators/${coordinatorKey}`;
	}

	function getCoordinatorLabel(coordinatorKey: string) {
		return (
			coordinators.find((entry) => entry.pubkey === coordinatorKey)?.label ||
			`Coordinator ${coordinatorKey.slice(0, 8)}`
		);
	}

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

	const keyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const coordinators = $derived.by(() => listChatCoordinators());

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
</script>

<svelte:head>
	<title>Key packages | Cordn</title>
	<meta name="description" content="Manage locally generated Cordn key packages." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
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
									{loading ? 'Generating…' : 'Generate key package'}
								</Button>
							</div>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Stored key packages</Card.Title>
					<Card.Description
						>Local records for the active account, ordered newest first.</Card.Description
					>
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
													href={getCoordinatorHref(coordinatorKey)}
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
		</div>
	</div>
</div>
