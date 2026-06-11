<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import VirtualKeyPackageList from '$lib/components/chat/VirtualKeyPackageList.svelte';
	import { matchesKeyPackageSearch } from '$lib/components/chat/keyPackageSearch';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		coordinatorDetailsActionsStore,
		loadCoordinatorRemoteKeyPackagesAction,
		startChatWithKeyPackageAction
	} from '$lib/services/chatUiActions.svelte';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { areStringArraysEqual } from '$lib/utils';
	import Users from '@lucide/svelte/icons/users';

	let {
		open = $bindable(false),
		onNavigate = () => {}
	}: {
		open?: boolean;
		onNavigate?: () => void;
	} = $props();

	let search = $state('');
	let startingRef = $state('');
	let error = $state('');

	const remoteKeyPackages = $derived.by(() =>
		coordinatorDetailsActionsStore.remoteKeyPackages.filter(
			(entry) => entry.pk !== $activeAccount?.pubkey
		)
	);

	let visibleKeyPackageIds = $state<string[]>([]);

	const visibleKeyPackagePubkeys = $derived.by(() => {
		const ids = new SvelteSet(visibleKeyPackageIds);
		const pubkeys = new SvelteSet<string>();
		for (const entry of filteredRemoteKeyPackages) {
			if (ids.has(entry.kp_ref)) pubkeys.add(entry.pk);
		}
		return [...pubkeys];
	});

	const keyPackageProfileHints = useProfileHints(
		() => {
			if (search) return remoteKeyPackages.map((kp) => kp.pk);
			return [...new Set(visibleKeyPackagePubkeys)];
		},
		{
			relays: metadataRelays
		}
	);

	const filteredRemoteKeyPackages = $derived.by(() =>
		remoteKeyPackages.filter((entry) =>
			matchesKeyPackageSearch({
				pubkey: entry.pk,
				keyPackageRef: entry.kp_ref,
				isLastResort: entry.last_resort,
				profileHints: keyPackageProfileHints,
				search
			})
		)
	);

	const visibleKeyPackageItems = $derived.by(() =>
		filteredRemoteKeyPackages.map((kp) => ({
			id: kp.kp_ref,
			entry: kp,
			actionLabel: startingRef === kp.kp_ref ? 'Starting…' : 'Start chat',
			actionDisabled: startingRef === kp.kp_ref,
			onAction: () => startChat(kp),
			className: 'bg-muted/20'
		}))
	);

	$effect(() => {
		if (open && $activeAccount) {
			search = '';
			error = '';
			visibleKeyPackageIds = [];
			loadCoordinatorRemoteKeyPackagesAction();
		}
	});

	function handleCreateGroupClick() {
		open = false;
		onNavigate();
	}

	async function startChat(kp: (typeof remoteKeyPackages)[number]) {
		if (!kp.coordinatorKey) {
			error = 'Add a coordinator before starting a chat';
			return;
		}

		try {
			startingRef = kp.kp_ref;
			error = '';
			const groupId = await startChatWithKeyPackageAction(kp);
			open = false;
			onNavigate();
			await goto(resolve('/chat/[id]', { id: groupId }));
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start chat';
		} finally {
			startingRef = '';
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[90vh] w-[min(calc(100vw-1.5rem),36rem)] sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>New conversation</Dialog.Title>
			<Dialog.Description>
				Create a new group or start a conversation from an available key package.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-4">
			<a
				href={resolve('/chat/create-group')}
				onclick={handleCreateGroupClick}
				class="flex items-center gap-3 rounded-xl border border-border p-4 transition-colors hover:bg-muted/30"
			>
				<div
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background"
				>
					<Users class="size-4" />
				</div>
				<div class="min-w-0">
					<p class="text-sm font-medium">Create group</p>
					<p class="text-xs text-muted-foreground">
						Start a new group chat with custom settings and member invites
					</p>
				</div>
			</a>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<Input
				bind:value={search}
				placeholder="Search by pubkey, package reference, or last resort"
				aria-label="Search available key packages"
			/>

			{#if !$activeAccount}
				<div
					class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
				>
					Log in to browse coordinator key packages.
				</div>
			{:else if coordinatorDetailsActionsStore.loadingKeyPackages && remoteKeyPackages.length === 0}
				<div class="flex justify-center py-8">
					<Spinner class="size-6" />
				</div>
			{:else if coordinatorDetailsActionsStore.keyPackageError}
				<p class="text-sm text-destructive">
					{coordinatorDetailsActionsStore.keyPackageError}
				</p>
			{:else if filteredRemoteKeyPackages.length > 0}
				<VirtualKeyPackageList
					items={visibleKeyPackageItems}
					maxHeightClass="max-h-[24rem]"
					contentClass="rounded-xl border border-border p-3"
					itemHeight={126}
					onVisibleItemsChange={(itemIds) => {
						if (areStringArraysEqual(itemIds, visibleKeyPackageIds)) return;
						visibleKeyPackageIds = itemIds;
					}}
				/>
			{:else if remoteKeyPackages.length > 0}
				<div
					class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
				>
					No key packages match your search.
				</div>
			{:else}
				<div
					class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
				>
					No public key packages found yet. Add coordinators and publish a key package first.
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
