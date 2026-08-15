<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import ChatPubkeyMultiSelect from '$lib/components/chat/ChatPubkeyMultiSelect.svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { availableKeyPackagesQueryOptions } from '$lib/queries/chatKeyPackageQueries';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		getDefaultChatCoordinator,
		getChatCoordinator,
		getCoordinatorColor,
		getCoordinatorLabel,
		listChatCoordinators,
		upsertChatCoordinator
	} from '$lib/services/chatCoordinators.svelte';
	import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
	import { createChatGroup, inviteChatGroupMember } from '$lib/services/chatGroups.svelte';
	import { toast } from 'svelte-sonner';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Plus from '@lucide/svelte/icons/plus';
	import Info from '@lucide/svelte/icons/info';
	import { isHexKey } from 'applesauce-core/helpers';

	let name = $state('');
	let description = $state('');
	let icon = $state('');
	let imageUrl = $state('');
	let coordinatorKey = $state(
		getDefaultChatCoordinator()?.pubkey ?? listChatCoordinators()[0]?.pubkey ?? ''
	);
	let selectedKeyPackageRef = $state('');
	let selectedMemberPubkeys = $state<string[]>([]);
	let selectedAdminPubkeys = $state<string[]>([]);
	let advancedOpen = $state(false);
	let loading = $state(false);
	let error = $state('');
	const coordinators = $derived.by(() => listChatCoordinators());
	// Match the selected pubkey against stored coordinators so the field can show
	// the friendly label + color dot (like the sidebar) instead of the raw hex.
	const selectedCoordinator = $derived(
		isHexKey(coordinatorKey.trim()) ? getChatCoordinator(coordinatorKey) : undefined
	);
	// Resolve through getCoordinatorLabel so a saved coordinator with the
	// auto-default label falls back to the server-announced name, matching the
	// sidebar/detail pages. While typing an unsaved pubkey, keep the raw value.
	const coordinatorDisplay = $derived(
		selectedCoordinator ? getCoordinatorLabel(coordinatorKey) : coordinatorKey
	);

	function onCoordinatorInput(event: Event) {
		coordinatorKey = (event.currentTarget as HTMLInputElement).value;
	}
	const availableKeyPackages = $derived.by(() => listChatKeyPackages($activeAccount?.pubkey));
	const querySafeCoordinatorKey = $derived.by(() => {
		const pubkey = coordinatorKey.trim();
		return pubkey && /^[0-9a-f]{64}$/i.test(pubkey) ? pubkey : undefined;
	});
	// Remote key packages for the selected coordinator, via the shared Svelte
	// Query cache — same source as the Start-chat directory and the ChatHeader
	// invite dropdown (AGENTS.md). Tightening `enabled` to require a valid
	// single coordinator prevents falling through to “fetch all coordinators”.
	const coordinatorKeyPackagesQuery = createQuery(() => {
		const coordinatorKey = querySafeCoordinatorKey;
		const base = availableKeyPackagesQueryOptions($activeAccount?.pubkey ?? '', coordinatorKey);
		return { ...base, enabled: base.enabled && coordinatorKey !== undefined };
	});
	const coordinatorMemberOptions = $derived.by(() => {
		if (!querySafeCoordinatorKey) return [];
		const entries = (coordinatorKeyPackagesQuery.data ?? [])
			.filter((entry) => entry.pk !== $activeAccount?.pubkey)
			.map((entry) => ({
				pubkey: entry.pk,
				description: `${entry.last_resort ? 'Last resort' : 'Standard'} · ${entry.kp_ref}`
			}));

		return Array.from(new Map(entries.map((entry) => [entry.pubkey, entry])).values());
	});
	const loadingCoordinatorMembers = $derived(
		querySafeCoordinatorKey !== undefined &&
			coordinatorKeyPackagesQuery.isFetching &&
			(coordinatorKeyPackagesQuery.data ?? []).length === 0
	);

	function samePubkeys(left: string[], right: string[]) {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	function selectCoordinator(pubkey: string) {
		coordinatorKey = pubkey;
	}

	function saveTypedCoordinator() {
		if (!coordinatorKey.trim()) return;
		upsertChatCoordinator({
			pubkey: coordinatorKey.trim()
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
			const adminPubkeys = selectedAdminPubkeys.length
				? Array.from(new Set([$activeAccount.pubkey, ...selectedAdminPubkeys]))
				: [];
			const group = await createChatGroup({
				name,
				description,
				icon,
				imageUrl,
				coordinatorKey,
				keyPackageRef: selectedKeyPackageRef || undefined,
				adminPubkeys
			});
			// Invite members individually so one failure (typically "no reachable
			// key package on this coordinator") can't silently abort every later
			// invite and leave phantom admins in metadata. The group is already
			// created, so failures are reported via toast and we still navigate in.
			let failedInvites = 0;
			for (const pubkey of selectedMemberPubkeys) {
				try {
					await inviteChatGroupMember({ groupId: group.id, identifier: pubkey });
				} catch {
					failedInvites += 1;
				}
			}
			if (failedInvites) {
				toast.error(
					`Group created, but ${failedInvites} of ${selectedMemberPubkeys.length} invite${
						failedInvites === 1 ? '' : 's'
					} failed. Make sure each member has published a key package on this coordinator, then add them from the group's info page.`
				);
			}
			await goto(resolve('/chat/[id]', { id: groupRouteId(group.id) }));
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
				<p class="text-sm text-muted-foreground">Your messages are end-to-end encrypted.</p>
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

					<div class="grid gap-5 sm:grid-cols-2">
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
					</div>

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

					<div class="space-y-5">
						<ChatPubkeyMultiSelect
							label="Members"
							helperText="Only people reachable on the hosting coordinator are listed."
							placeholder="Search available members…"
							emptyLabel={coordinatorKey.trim()
								? loadingCoordinatorMembers
									? 'Loading available members…'
									: 'No one else is reachable on this coordinator yet.'
								: 'Select a coordinator to see available members.'}
							options={coordinatorMemberOptions}
							bind:selectedPubkeys={selectedMemberPubkeys}
						/>

						<ChatPubkeyMultiSelect
							label="Admins"
							helperText="Pick admins from the selected members. If you choose any admins, your active account is also included automatically. Leave empty to keep the group egalitarian."
							placeholder="Search selected members…"
							emptyLabel="Select members first to choose admins."
							options={coordinatorMemberOptions.filter((option) =>
								selectedMemberPubkeys.includes(option.pubkey)
							)}
							bind:selectedPubkeys={selectedAdminPubkeys}
						/>
					</div>

					<Collapsible.Root bind:open={advancedOpen}>
						<Collapsible.Trigger>
							{#snippet child({ props })}
								<button
									{...props}
									type="button"
									class="flex w-full items-center justify-between gap-3 rounded-2xl border border-border px-4 py-3 text-left font-medium transition-colors hover:bg-muted/30"
								>
									<span class="flex min-w-0 items-center gap-2">
										{#if selectedCoordinator}
											<span
												class="size-2.5 shrink-0 rounded-full border border-border"
												style={`background-color: ${getCoordinatorColor(selectedCoordinator)};`}
												aria-hidden="true"
											></span>
										{/if}
										<span class="truncate">Hosting on {coordinatorDisplay || 'no coordinator'}</span
										>
									</span>
									<span class="shrink-0 text-sm font-normal text-muted-foreground">
										{advancedOpen ? 'Hide' : 'Change'}
										<ChevronDown
											class="ml-1 inline size-4 align-[-3px] transition-transform [[data-state=open]_&]:rotate-180"
										/>
									</span>
								</button>
							{/snippet}
						</Collapsible.Trigger>
						<Collapsible.Content>
							<div class="mt-4 space-y-5">
								<InputGroup.Root>
									<InputGroup.Input
										value={coordinatorDisplay}
										oninput={onCoordinatorInput}
										readonly={!!selectedCoordinator}
										placeholder="64-char coordinator pubkey"
										class={selectedCoordinator ? '' : 'font-mono'}
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
														<DropdownMenu.Item
															onSelect={() => selectCoordinator(coordinator.pubkey)}
														>
															<span
																class="size-2.5 shrink-0 rounded-full border border-border"
																style={`background-color: ${getCoordinatorColor(coordinator)};`}
																aria-hidden="true"
															></span>
															{getCoordinatorLabel(coordinator.pubkey)}
														</DropdownMenu.Item>
													{/each}
												{/if}
												{#if coordinatorKey.trim() && !selectedCoordinator}
													<DropdownMenu.Item onSelect={saveTypedCoordinator}
														>Save current value</DropdownMenu.Item
													>
												{/if}
												<DropdownMenu.Item onSelect={() => selectCoordinator('')}
													>Clear</DropdownMenu.Item
												>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</InputGroup.Addon>
									<InputGroup.Addon align="inline-end">
										<Info class="size-4 text-muted-foreground" />
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
							</div>
						</Collapsible.Content>
					</Collapsible.Root>

					{#if error}
						<p class="text-sm text-destructive">{error}</p>
					{/if}

					<div class="flex justify-end">
						<Button type="submit" disabled={loading || !name.trim() || !coordinatorKey.trim()}>
							{#if loading}
								<Spinner class="mr-2 size-4" />
							{/if}
							{loading ? 'Creating…' : 'Create group'}
						</Button>
					</div>
				</form>
			{/if}
		</div>
	</div>
</div>
