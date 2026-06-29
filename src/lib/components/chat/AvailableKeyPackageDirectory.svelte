<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import VirtualKeyPackageList from '$lib/components/chat/VirtualKeyPackageList.svelte';
	import { matchesKeyPackageSearch } from '$lib/components/chat/keyPackageSearch';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		useAvailableKeyPackages,
		type AvailableKeyPackageWithCoordinator
	} from '$lib/queries/chatKeyPackageQueries';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import {
		getChatCoordinator,
		getCoordinatorColor,
		getCoordinatorLabel
	} from '$lib/services/chatCoordinators.svelte';
	import { areStringArraysEqual, cn, normalizePubKey } from '$lib/utils';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Filter from '@lucide/svelte/icons/filter';

	type Props = {
		onStartChat: (entry: AvailableKeyPackageWithCoordinator) => void | Promise<void>;
		startingRef?: string;
		/** Include the active account's own packages (shown with a "You" badge). */
		includeSelf?: boolean;
		/** Show the "Showing N key packages" count line. */
		showCount?: boolean;
		/** Show the collapsible coordinator filter pills. */
		showCoordinatorFilter?: boolean;
		maxHeightClass?: string;
		emptyMessage?: string;
	};

	let {
		onStartChat,
		startingRef = '',
		includeSelf = false,
		showCount = false,
		showCoordinatorFilter = false,
		maxHeightClass = 'max-h-[24rem]',
		emptyMessage = 'No public key packages found yet.'
	}: Props = $props();

	let search = $state('');
	let coordinatorFilter = $state<string>('all');
	let filterOpen = $state(false);
	let visibleKeyPackageIds = $state<string[]>([]);

	const activePubkey = $derived($activeAccount ? normalizePubKey($activeAccount.pubkey) : '');
	const availableKeyPackagesQuery = useAvailableKeyPackages(() => $activeAccount?.pubkey);
	const remoteKeyPackages = $derived(availableKeyPackagesQuery.data ?? []);

	// Dialog lists others only (people you can start a chat with); the chat home
	// directory includes your own packages with a "You" badge. Normalized compare
	// so an uppercase/npub active pubkey never leaks your own card into "Start chat".
	const scopedKeyPackages = $derived(
		includeSelf
			? remoteKeyPackages
			: remoteKeyPackages.filter((entry) => normalizePubKey(entry.pk) !== activePubkey)
	);

	const filteredKeyPackages = $derived(
		scopedKeyPackages.filter(
			(entry) =>
				(coordinatorFilter === 'all' || entry.coordinatorKey === coordinatorFilter) &&
				matchesKeyPackageSearch({
					pubkey: entry.pk,
					keyPackageRef: entry.kp_ref,
					isLastResort: entry.last_resort,
					profileHints,
					search
				})
		)
	);

	// ponytail: coordinators are derived from the actual data so the filter
	// only lists coordinators that currently expose key packages.
	const coordinatorFilterOptions = $derived.by(() => {
		const options: { pubkey: string; label: string; color: string }[] = [];
		for (const entry of remoteKeyPackages) {
			if (options.some((o) => o.pubkey === entry.coordinatorKey)) continue;
			const stored = getChatCoordinator(entry.coordinatorKey);
			options.push({
				pubkey: entry.coordinatorKey,
				label: getCoordinatorLabel(entry.coordinatorKey),
				color: getCoordinatorColor(stored ?? { pubkey: entry.coordinatorKey, color: undefined })
			});
		}
		return options;
	});

	const visibleKeyPackagePubkeys = $derived.by(() => {
		const ids = new SvelteSet(visibleKeyPackageIds);
		const pubkeys = new SvelteSet<string>();
		for (const entry of filteredKeyPackages) {
			if (ids.has(entry.kp_ref)) pubkeys.add(entry.pk);
		}
		return [...pubkeys];
	});

	const profileHints = useProfileHints(
		() => {
			if (search) return remoteKeyPackages.map((kp) => kp.pk);
			return [...new Set(visibleKeyPackagePubkeys)];
		},
		{ relays: metadataRelays }
	);

	const ownFilteredKeyPackageCount = $derived(
		filteredKeyPackages.filter((entry) => normalizePubKey(entry.pk) === activePubkey).length
	);
	const showCoordinatorBorder = $derived(showCoordinatorFilter && coordinatorFilter === 'all');

	const items = $derived(
		filteredKeyPackages.map((entry) => {
			const isOwn = normalizePubKey(entry.pk) === activePubkey;
			const isStarting = startingRef === entry.kp_ref;
			const coordinatorColor = getCoordinatorColor(
				getChatCoordinator(entry.coordinatorKey) ?? {
					pubkey: entry.coordinatorKey,
					color: undefined
				}
			);
			return {
				id: entry.kp_ref,
				entry,
				pubkey: entry.pk,
				badge: isOwn ? 'You' : undefined,
				actionLabel: isOwn ? undefined : isStarting ? 'Starting…' : 'Start chat',
				actionDisabled: isStarting,
				onAction: isOwn ? undefined : () => onStartChat(entry),
				className: showCoordinatorBorder ? 'border-l-4 bg-muted/20' : 'bg-muted/20',
				style: showCoordinatorBorder ? `border-left-color: ${coordinatorColor};` : undefined
			};
		})
	);

	function coordinatorPillClass(active: boolean) {
		return cn(
			'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
			active
				? 'border-primary bg-primary/10 text-foreground'
				: 'border-border text-muted-foreground hover:text-foreground'
		);
	}
</script>

{#if !$activeAccount}
	<div
		class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
	>
		Log in to browse coordinator key packages.
	</div>
{:else}
	<div class="space-y-3">
		{#if showCount || showCoordinatorFilter}
			<div class="flex flex-wrap items-center justify-between gap-2">
				{#if showCount}
					<p class="text-xs text-muted-foreground">
						Showing {filteredKeyPackages.length} key package{filteredKeyPackages.length === 1
							? ''
							: 's'}
						{#if includeSelf && ownFilteredKeyPackageCount > 0}
							<span class="ml-1">· {ownFilteredKeyPackageCount} yours</span>
						{/if}
					</p>
				{/if}
				{#if showCoordinatorFilter}
					<Collapsible.Root bind:open={filterOpen}>
						<Collapsible.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="ghost" size="sm" class="gap-1.5 text-muted-foreground">
									<Filter class="size-4" />
									{filterOpen ? 'Hide filters' : 'Filter by coordinator'}
									<ChevronDown
										class={`size-4 transition-transform ${filterOpen ? 'rotate-180' : ''}`}
									/>
								</Button>
							{/snippet}
						</Collapsible.Trigger>
						<Collapsible.Content>
							{#if coordinatorFilterOptions.length > 0}
								<div class="flex flex-wrap gap-2 pt-2">
									<button
										type="button"
										onclick={() => (coordinatorFilter = 'all')}
										class={coordinatorPillClass(coordinatorFilter === 'all')}
									>
										All coordinators
									</button>
									{#each coordinatorFilterOptions as option (option.pubkey)}
										<button
											type="button"
											onclick={() => (coordinatorFilter = option.pubkey)}
											class={coordinatorPillClass(coordinatorFilter === option.pubkey)}
										>
											<span class="size-2 rounded-full" style={`background-color: ${option.color};`}
											></span>
											{option.label}
										</button>
									{/each}
								</div>
							{:else}
								<p class="pt-2 text-xs text-muted-foreground">
									No coordinators with key packages yet.
								</p>
							{/if}
						</Collapsible.Content>
					</Collapsible.Root>
				{/if}
			</div>
		{/if}

		<Input
			bind:value={search}
			placeholder="Search by pubkey, package reference, or last resort"
			aria-label="Search available key packages"
		/>

		{#if availableKeyPackagesQuery.isFetching && scopedKeyPackages.length === 0}
			<div class="flex justify-center py-8">
				<Spinner class="size-6" />
			</div>
		{:else if availableKeyPackagesQuery.error}
			<p class="text-sm text-destructive">
				{availableKeyPackagesQuery.error instanceof Error
					? availableKeyPackagesQuery.error.message
					: 'Failed to load remote key packages'}
			</p>
		{:else if filteredKeyPackages.length > 0}
			<VirtualKeyPackageList
				{items}
				{maxHeightClass}
				itemHeight={126}
				onVisibleItemsChange={(itemIds) => {
					if (areStringArraysEqual(itemIds, visibleKeyPackageIds)) return;
					visibleKeyPackageIds = itemIds;
				}}
			/>
		{:else if scopedKeyPackages.length > 0}
			<div
				class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
			>
				No key packages match your search.
			</div>
		{:else}
			<div
				class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
			>
				{emptyMessage}
			</div>
		{/if}
	</div>
{/if}
