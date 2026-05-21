<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getCoordinatorColor,
		getChatCoordinator,
		listChatCoordinators,
		removeChatCoordinator,
		setDefaultChatCoordinator,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
	import Bolt from '@lucide/svelte/icons/bolt';
	import Check from '@lucide/svelte/icons/check';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Server from '@lucide/svelte/icons/server';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	let label = $state('');
	let pubkey = $state('');
	let relays = $state('');
	let color = $state('');
	let isDefault = $state(false);
	let error = $state('');

	const coordinators = $derived.by(() => listChatCoordinators());
	const groups = $derived.by(() => listChatGroups());
	const localKeyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const knownCoordinatorKeys = $derived.by(() => {
		const keys = new Set<string>();
		for (const coordinator of coordinators) keys.add(coordinator.pubkey);
		for (const group of groups) keys.add(group.coordinatorKey);
		for (const keyPackage of localKeyPackages) {
			for (const coordinatorKey of keyPackage.publishedCoordinatorKeys) keys.add(coordinatorKey);
		}
		return [...keys];
	});
	const coordinatorEntries = $derived.by(() =>
		knownCoordinatorKeys.map((pubkey) => {
			const saved = getChatCoordinator(pubkey);
			return {
				pubkey,
				label: saved?.label || `Coordinator ${pubkey.slice(0, 8)}`,
				color: getCoordinatorColor(saved ?? { pubkey, color: undefined }),
				relays: saved?.relays ?? [],
				isDefault: saved?.isDefault ?? false,
				isSaved: Boolean(saved),
				lastUsedAt: saved?.lastUsedAt
			};
		})
	);

	function parseRelayList(value: string): string[] {
		return value
			.split(/[,\n]/)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		try {
			error = '';
			upsertChatCoordinator({
				pubkey,
				label,
				relays: parseRelayList(relays),
				isDefault,
				color
			});
			label = '';
			pubkey = '';
			relays = '';
			color = '';
			isDefault = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save coordinator';
		}
	}

	function getCoordinatorGroupCount(pubkey: string): number {
		return groups.filter((group) => group.coordinatorKey === pubkey).length;
	}

	function getCoordinatorPublishedCount(pubkey: string): number {
		return localKeyPackages.filter((entry) => entry.publishedCoordinatorKeys.includes(pubkey))
			.length;
	}

	function saveCoordinator(pubkey: string) {
		upsertChatCoordinator({ pubkey });
	}
</script>

<svelte:head>
	<title>Coordinators | Cordn</title>
	<meta name="description" content="Coordinator hub for Cordn chat." />
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
				<h1 class="text-lg font-semibold tracking-tight">Coordinators</h1>
				<p class="text-sm text-muted-foreground">
					Manage coordinator profiles, defaults, relays, and remote inspection entry points.
				</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto max-w-6xl space-y-6">
			<div class="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
				<Card.Root>
					<Card.Header>
						<Card.Title>Add coordinator</Card.Title>
						<Card.Description>
							Register a reusable coordinator profile with relays, default selection, and visual
							identity.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						{#if !$activeAccount}
							<div class="space-y-3">
								<p class="text-sm text-muted-foreground">
									Log in to manage local coordinator settings.
								</p>
								<AccountLoginDialog />
							</div>
						{:else}
							<form class="space-y-4" onsubmit={handleSubmit}>
								<InputGroup.Root>
									<InputGroup.Input
										bind:value={label}
										placeholder="Local label, e.g. Main coordinator"
									/>
									<InputGroup.Addon>
										<InputGroup.Text>Label</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Input
										bind:value={pubkey}
										class="font-mono text-xs"
										placeholder="64-char coordinator pubkey"
									/>
									<InputGroup.Addon>
										<InputGroup.Text>Pubkey</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Textarea
										bind:value={relays}
										class="min-h-24 font-mono text-xs"
										placeholder="wss://relay.example.org"
									/>
									<InputGroup.Addon align="block-start">
										<InputGroup.Text>Relays</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<InputGroup.Root>
									<InputGroup.Input
										bind:value={color}
										placeholder="#a1b2c3 (optional override)"
										class="font-mono text-xs"
									/>
									<InputGroup.Addon>
										<InputGroup.Text>Color</InputGroup.Text>
									</InputGroup.Addon>
								</InputGroup.Root>

								<label class="flex items-center gap-2 text-sm text-muted-foreground">
									<input
										bind:checked={isDefault}
										type="checkbox"
										class="h-4 w-4 rounded border-border"
									/>
									Set as default coordinator
								</label>

								{#if error}
									<p class="text-sm text-destructive">{error}</p>
								{/if}

								<div class="flex justify-end">
									<Button type="submit" disabled={!pubkey.trim()}>Save coordinator</Button>
								</div>
							</form>
						{/if}
					</Card.Content>
				</Card.Root>

				<div class="grid gap-6 md:grid-cols-3">
					<Card.Root>
						<Card.Header>
							<Card.Title>Saved profiles</Card.Title>
							<Card.Description>Locally stored coordinator endpoints.</Card.Description>
						</Card.Header>
						<Card.Content>
							<p class="text-3xl font-semibold">{coordinators.length}</p>
						</Card.Content>
					</Card.Root>
					<Card.Root>
						<Card.Header>
							<Card.Title>Groups</Card.Title>
							<Card.Description>Local groups mapped to coordinators.</Card.Description>
						</Card.Header>
						<Card.Content>
							<p class="text-3xl font-semibold">{groups.length}</p>
						</Card.Content>
					</Card.Root>
					<Card.Root>
						<Card.Header>
							<Card.Title>Published KPs</Card.Title>
							<Card.Description>Local key packages published to any coordinator.</Card.Description>
						</Card.Header>
						<Card.Content>
							<p class="text-3xl font-semibold">
								{localKeyPackages.filter((entry) => entry.publishedCoordinatorKeys.length > 0)
									.length}
							</p>
						</Card.Content>
					</Card.Root>
				</div>
			</div>

			<Card.Root>
				<Card.Header>
					<Card.Title>Known coordinators</Card.Title>
					<Card.Description>
						Coordinator pubkeys referenced by saved profiles, groups, or published key packages.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<div class="grid gap-4 lg:grid-cols-2">
						{#if coordinatorEntries.length === 0}
							<div
								class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground lg:col-span-2"
							>
								No coordinators are referenced yet.
							</div>
						{:else}
							{#each coordinatorEntries as coordinator (coordinator.pubkey)}
								<div class="rounded-2xl border border-border bg-card/40 p-4">
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0 space-y-2">
											<div class="flex items-center gap-2">
												<span
													class="h-3 w-3 rounded-full border border-border"
													style={`background-color: ${coordinator.color};`}
													aria-hidden="true"
												></span>
												<p class="truncate font-medium">{coordinator.label}</p>
												{#if !coordinator.isSaved}
													<span
														class="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
														>Unsaved</span
													>
												{/if}
												{#if coordinator.isDefault}
													<span
														class="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
														>Default</span
													>
												{/if}
											</div>
											<p class="font-mono text-xs break-all text-muted-foreground">
												{coordinator.pubkey}
											</p>
											<p class="text-xs text-muted-foreground">
												{coordinator.relays.length > 0
													? coordinator.relays.join(' · ')
													: 'No saved relays'}
											</p>
										</div>
										<div class="flex shrink-0 items-center gap-1">
											{#if coordinator.isSaved && !coordinator.isDefault}
												<Button
													type="button"
													variant="ghost"
													size="icon"
													onclick={() => setDefaultChatCoordinator(coordinator.pubkey)}
												>
													<Check class="size-4" />
												</Button>
											{/if}
											{#if coordinator.isSaved}
												<Button
													type="button"
													variant="ghost"
													size="icon"
													onclick={() => removeChatCoordinator(coordinator.pubkey)}
												>
													<Trash2 class="size-4" />
												</Button>
											{/if}
										</div>
									</div>

									<div class="mt-4 grid gap-3 sm:grid-cols-3">
										<div class="rounded-xl border border-border/70 px-3 py-2">
											<p class="text-[11px] tracking-wide text-muted-foreground uppercase">
												Groups
											</p>
											<p class="text-lg font-semibold">
												{getCoordinatorGroupCount(coordinator.pubkey)}
											</p>
										</div>
										<div class="rounded-xl border border-border/70 px-3 py-2">
											<p class="text-[11px] tracking-wide text-muted-foreground uppercase">
												Published KPs
											</p>
											<p class="text-lg font-semibold">
												{getCoordinatorPublishedCount(coordinator.pubkey)}
											</p>
										</div>
										<div class="rounded-xl border border-border/70 px-3 py-2">
											<p class="text-[11px] tracking-wide text-muted-foreground uppercase">
												Last used
											</p>
											<p class="text-sm font-medium">
												{coordinator.lastUsedAt
													? new Date(coordinator.lastUsedAt).toLocaleString()
													: 'Not yet'}
											</p>
										</div>
									</div>

									<div class="mt-4 flex flex-wrap gap-2">
										<Button href={`/chat/coordinators/${coordinator.pubkey}`}>Open detail</Button>
										{#if !coordinator.isSaved}
											<Button
												type="button"
												variant="outline"
												onclick={() => saveCoordinator(coordinator.pubkey)}>Save locally</Button
											>
										{/if}
										<Button
											href={`../create-group?coordinator=${coordinator.pubkey}`}
											variant="outline">Create group</Button
										>
										<Button href="../config/key-packages" variant="outline"
											>Open key packages</Button
										>
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</Card.Content>
				<Card.Footer class="flex-wrap justify-between gap-3 border-t border-border pt-6">
					<p class="text-sm text-muted-foreground">
						Coordinators are the primary operational boundary for Cordn groups, key packages, and
						welcomes.
					</p>
					<div class="flex gap-2">
						<Button href="../create-group" variant="outline">
							<Bolt class="mr-2 size-4" />
							Create group
						</Button>
						<Button href="../config/key-packages" variant="outline">
							<KeyRound class="mr-2 size-4" />
							Key packages
						</Button>
					</div>
				</Card.Footer>
			</Card.Root>
		</div>
	</div>
</div>
