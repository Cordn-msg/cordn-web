<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ChatPubkeyMultiSelect from '$lib/components/chat/ChatPubkeyMultiSelect.svelte';
	import { fetchCoordinatorAvailableKeyPackages } from '$lib/queries/chatKeyPackageQueries';
	import type { AvailableKeyPackage } from '$lib/contracts';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getDefaultChatCoordinator,
		listChatCoordinators,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
	import { createChatGroup, inviteChatGroupMember } from '$lib/services/chatGroups.svelte';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Plus from '@lucide/svelte/icons/plus';
	import Info from '@lucide/svelte/icons/info';
	import { nip19 } from 'nostr-tools';

	let name = $state('');
	let description = $state('');
	let icon = $state('');
	let imageUrl = $state('');
	let coordinatorKey = $state(getDefaultChatCoordinator()?.pubkey ?? '');
	let coordinatorRelays = $state(getDefaultChatCoordinator()?.relays.join('\n') ?? '');
	let selectedKeyPackageRef = $state('');
	let keyPackageLabel = $state('');
	let keyPackageIsLastResort = $state(false);
	let selectedMemberPubkeys = $state<string[]>([]);
	let selectedAdminPubkeys = $state<string[]>([]);
	let loading = $state(false);
	let loadingCoordinatorMembers = $state(false);
	let remoteAvailableKeyPackages = $state<AvailableKeyPackage[]>([]);
	let error = $state('');
	const coordinators = $derived.by(() => listChatCoordinators());
	const availableKeyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const querySafeCoordinatorKey = $derived.by(() => {
		const pubkey = coordinatorKey.trim();
		return pubkey && /^[0-9a-f]{64}$/i.test(pubkey) ? pubkey : undefined;
	});
	const hasValidActiveAccount = $derived.by(() =>
		Boolean($activeAccount?.pubkey?.trim() && /^[0-9a-f]{64}$/i.test($activeAccount.pubkey))
	);
	const coordinatorMemberOptions = $derived.by(() => {
		const entries = remoteAvailableKeyPackages
			.filter((entry) => entry.pk !== $activeAccount?.pubkey)
			.map((entry) => ({
				pubkey: entry.pk,
				label: nip19.npubEncode(entry.pk).slice(0, 16),
				description: `${entry.last_resort ? 'Last resort' : 'Standard'} · ${entry.kp_ref}`
			}));

		return Array.from(new Map(entries.map((entry) => [entry.pubkey, entry])).values());
	});

	function samePubkeys(left: string[], right: string[]) {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	$effect(() => {
		if (!hasValidActiveAccount || !querySafeCoordinatorKey) {
			remoteAvailableKeyPackages = [];
			loadingCoordinatorMembers = false;
			return;
		}

		let cancelled = false;
		loadingCoordinatorMembers = true;

		void fetchCoordinatorAvailableKeyPackages(querySafeCoordinatorKey)
			.then((entries) => {
				if (cancelled) return;
				remoteAvailableKeyPackages = entries;
			})
			.catch(() => {
				if (cancelled) return;
				remoteAvailableKeyPackages = [];
			})
			.finally(() => {
				if (cancelled) return;
				loadingCoordinatorMembers = false;
			});

		return () => {
			cancelled = true;
		};
	});

	function parseRelayList(value: string): string[] {
		return value
			.split(/[\n,]/)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	function selectCoordinator(pubkey: string) {
		coordinatorKey = pubkey;
		const coordinator = coordinators.find((entry) => entry.pubkey === pubkey);
		coordinatorRelays = coordinator?.relays.join('\n') ?? '';
	}

	function saveTypedCoordinator() {
		if (!coordinatorKey.trim()) return;
		upsertChatCoordinator({
			pubkey: coordinatorKey.trim(),
			relays: parseRelayList(coordinatorRelays)
		});
	}

	$effect(() => {
		const allowedPubkeys = new Set(coordinatorMemberOptions.map((entry) => entry.pubkey));
		const nextSelectedMembers = selectedMemberPubkeys.filter((pubkey) =>
			allowedPubkeys.has(pubkey)
		);
		const nextSelectedAdmins = selectedAdminPubkeys.filter(
			(pubkey) => nextSelectedMembers.includes(pubkey) && allowedPubkeys.has(pubkey)
		);

		if (!samePubkeys(selectedMemberPubkeys, nextSelectedMembers)) {
			selectedMemberPubkeys = nextSelectedMembers;
		}

		if (!samePubkeys(selectedAdminPubkeys, nextSelectedAdmins)) {
			selectedAdminPubkeys = nextSelectedAdmins;
		}
	});

	async function handleSubmit(event: Event) {
		event.preventDefault();
		if (!$activeAccount) {
			error = 'Log in before creating a group';
			return;
		}
		try {
			loading = true;
			error = '';
			const group = await createChatGroup({
				name,
				description,
				icon,
				imageUrl,
				coordinatorKey,
				keyPackageRef: selectedKeyPackageRef || undefined,
				keyPackageLabel: selectedKeyPackageRef ? undefined : keyPackageLabel,
				keyPackageIsLastResort: selectedKeyPackageRef ? undefined : keyPackageIsLastResort,
				adminPubkeys: selectedAdminPubkeys
			});
			for (const pubkey of selectedMemberPubkeys) {
				await inviteChatGroupMember({ groupId: group.id, identifier: pubkey });
			}
			await goto(resolve('/chat/[id]', { id: group.id }));
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create group';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Create group | Cordn</title>
	<meta name="description" content="Create a new Cordn group." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Plus class="size-4" />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">Create group</h1>
				<p class="text-sm text-muted-foreground">
					Create a real Cordn MLS group bound to a coordinator.
				</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto max-w-2xl rounded-2xl border border-border bg-card p-6 shadow-sm">
			{#if !$activeAccount}
				<div class="space-y-4">
					<p class="text-sm text-muted-foreground">
						Log in first so the group can be created with your Nostr identity.
					</p>
					<AccountLoginDialog />
				</div>
			{:else}
				<form class="space-y-5" onsubmit={handleSubmit}>
					<InputGroup.Root>
						<InputGroup.Input bind:value={name} placeholder="Group name" />
						<InputGroup.Addon>
							<InputGroup.Text>Name</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>

					<InputGroup.Root>
						<InputGroup.Input
							bind:value={coordinatorKey}
							placeholder="64-char coordinator pubkey"
							class="font-mono"
						/>
						<InputGroup.Addon>
							<InputGroup.Text>Coordinator</InputGroup.Text>
						</InputGroup.Addon>
						<InputGroup.Addon align="inline-end">
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<InputGroup.Button {...props} variant="ghost" class="!pe-1.5 text-xs">
											Use saved <ChevronDown class="size-3" />
										</InputGroup.Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									{#if coordinators.length === 0}
										<DropdownMenu.Item disabled>No saved coordinators</DropdownMenu.Item>
									{:else}
										{#each coordinators as coordinator (coordinator.pubkey)}
											<DropdownMenu.Item onSelect={() => selectCoordinator(coordinator.pubkey)}>
												{coordinator.label}
											</DropdownMenu.Item>
										{/each}
									{/if}
									{#if coordinatorKey.trim()}
										<DropdownMenu.Item onSelect={saveTypedCoordinator}
											>Save current value</DropdownMenu.Item
										>
									{/if}
									<DropdownMenu.Item onSelect={() => selectCoordinator('')}>Clear</DropdownMenu.Item
									>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</InputGroup.Addon>
						<InputGroup.Addon align="inline-end">
							<Info class="size-4 text-muted-foreground" />
						</InputGroup.Addon>
					</InputGroup.Root>

					<InputGroup.Root>
						<InputGroup.Textarea
							bind:value={coordinatorRelays}
							class="min-h-24 font-mono text-xs"
							placeholder="wss://relay.example.org"
						/>
						<InputGroup.Addon align="block-start">
							<InputGroup.Text>Relays</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>

					<InputGroup.Root>
						<InputGroup.Input
							value={selectedKeyPackageRef
								? availableKeyPackages.find(
										(entry) => entry.keyPackageRef === selectedKeyPackageRef
									)?.label || selectedKeyPackageRef
								: 'Generate a new key package'}
							readonly
							placeholder="Select an existing key package or generate a new one"
						/>
						<InputGroup.Addon>
							<InputGroup.Text>Key package</InputGroup.Text>
						</InputGroup.Addon>
						<InputGroup.Addon align="inline-end">
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<InputGroup.Button {...props} variant="ghost" class="!pe-1.5 text-xs">
											Choose <ChevronDown class="size-3" />
										</InputGroup.Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item onSelect={() => (selectedKeyPackageRef = '')}>
										Generate new key package
									</DropdownMenu.Item>
									{#each availableKeyPackages as keyPackage (keyPackage.keyPackageRef)}
										<DropdownMenu.Item
											onSelect={() => (selectedKeyPackageRef = keyPackage.keyPackageRef)}
										>
											{keyPackage.label}
										</DropdownMenu.Item>
									{/each}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</InputGroup.Addon>
						<InputGroup.Addon align="inline-end">
							<KeyRound class="size-4 text-muted-foreground" />
						</InputGroup.Addon>
					</InputGroup.Root>

					{#if !selectedKeyPackageRef}
						<InputGroup.Root>
							<InputGroup.Input
								bind:value={keyPackageLabel}
								placeholder="Optional label for the new key package"
							/>
							<InputGroup.Addon>
								<InputGroup.Text>KP label</InputGroup.Text>
							</InputGroup.Addon>
						</InputGroup.Root>

						<label class="flex items-center gap-2 text-sm text-muted-foreground">
							<input
								bind:checked={keyPackageIsLastResort}
								type="checkbox"
								class="h-4 w-4 rounded border-border"
							/>
							Generate as last resort key package
						</label>
					{/if}

					<ChatPubkeyMultiSelect
						label="Members"
						helperText="Invite members from the selected coordinator's available key packages."
						placeholder="Search available members…"
						emptyLabel={coordinatorKey.trim()
							? loadingCoordinatorMembers
								? 'Loading coordinator key packages…'
								: 'No available key packages found for this coordinator.'
							: 'Select a coordinator to load available key packages.'}
						options={coordinatorMemberOptions}
						bind:selectedPubkeys={selectedMemberPubkeys}
					/>

					<ChatPubkeyMultiSelect
						label="Admins"
						helperText="Pick admins from the members selected above. Leave empty to keep the group egalitarian."
						placeholder="Search selected members…"
						emptyLabel="Select members first to choose admins."
						options={coordinatorMemberOptions.filter((option) =>
							selectedMemberPubkeys.includes(option.pubkey)
						)}
						bind:selectedPubkeys={selectedAdminPubkeys}
					/>

					<InputGroup.Root>
						<InputGroup.Input bind:value={icon} placeholder="🪢" />
						<InputGroup.Addon>
							<InputGroup.Text>Icon</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>

					<InputGroup.Root>
						<InputGroup.Input bind:value={imageUrl} placeholder="https://example.com/group.png" />
						<InputGroup.Addon>
							<InputGroup.Text>Image</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>

					<InputGroup.Root>
						<InputGroup.Textarea
							bind:value={description}
							placeholder="Describe the group"
							class="min-h-28"
						/>
						<InputGroup.Addon align="block-start">
							<InputGroup.Text>Description</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>

					{#if error}
						<p class="text-sm text-destructive">{error}</p>
					{/if}

					<div class="flex justify-end">
						<Button type="submit" disabled={loading || !name.trim() || !coordinatorKey.trim()}>
							{loading ? 'Creating…' : 'Create group'}
						</Button>
					</div>
				</form>
			{/if}
		</div>
	</div>
</div>
