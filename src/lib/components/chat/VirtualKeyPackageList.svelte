<script lang="ts">
	import { browser } from '$app/environment';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import { onMount, tick, untrack } from 'svelte';
	import KeyPackageCard from '$lib/components/chat/KeyPackageCard.svelte';
	import type { AvailableKeyPackage } from '$lib/contracts';
	import type { CoordinatorAvailableKeyPackage } from '$lib/services/chatGroups.svelte';
	import type { StoredKeyPackageRecord } from '$lib/services/chatKeyPackages.svelte';

	type KeyPackageEntry =
		| StoredKeyPackageRecord
		| AvailableKeyPackage
		| CoordinatorAvailableKeyPackage;

	export type VirtualKeyPackageListItem = {
		id: string;
		entry: KeyPackageEntry;
		actionLabel?: string;
		actionDisabled?: boolean;
		onAction?: () => void | Promise<void>;
		badge?: string;
		compact?: boolean;
		className?: string;
	};

	const ESTIMATED_ROW_HEIGHT = 180;
	const VIRTUAL_OVERSCAN = 4;

	type Props = {
		items: VirtualKeyPackageListItem[];
		emptyMessage?: string;
		maxHeightClass?: string;
		contentClass?: string;
		itemHeight?: number;
		itemGap?: number;
		onVisibleItemsChange?: (itemIds: string[]) => void;
	};

	let {
		items,
		emptyMessage = 'No key packages available.',
		maxHeightClass = 'max-h-[24rem]',
		contentClass = 'rounded-xl border border-border p-3',
		itemHeight = ESTIMATED_ROW_HEIGHT,
		itemGap = 12,
		onVisibleItemsChange
	}: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let mounted = $state(false);

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => container,
		estimateSize: () => itemHeight + itemGap,
		overscan: VIRTUAL_OVERSCAN,
		getItemKey: (index) => items[index]?.id ?? index
	});

	const virtualItems = $derived($virtualizer.getVirtualItems());
	const totalSize = $derived($virtualizer.getTotalSize());
	let lastVisibleItemIds: string[] = [];

	function applyVirtualizerOptions(count: number) {
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => container,
				getItemKey: (index) => items[index]?.id ?? index
			});
		});
	}

	function areStringArraysEqual(left: string[], right: string[]) {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	function measureVisibleItems() {
		if (!browser || !container) return;
		for (const element of container.querySelectorAll<HTMLDivElement>('[data-virtual-item]')) {
			$virtualizer.measureElement(element);
		}
	}

	function measureVirtualItem(node: HTMLDivElement) {
		if (!browser) return;
		$virtualizer.measureElement(node);
		const observer = new ResizeObserver(() => {
			$virtualizer.measureElement(node);
		});
		observer.observe(node);

		return {
			destroy() {
				observer.disconnect();
			}
		};
	}

	onMount(() => {
		mounted = true;
		const resizeObserver =
			browser && container
				? new ResizeObserver(() => {
						void tick().then(measureVisibleItems);
					})
				: null;

		if (container && resizeObserver) {
			resizeObserver.observe(container);
		}

		void tick().then(() => {
			applyVirtualizerOptions(items.length);
			untrack(() => {
				$virtualizer.measure();
			});
			measureVisibleItems();
		});
		return () => {
			mounted = false;
			resizeObserver?.disconnect();
		};
	});

	$effect(() => {
		if (!mounted) return;
		const itemCount = items.length;
		void tick().then(() => {
			applyVirtualizerOptions(itemCount);
			measureVisibleItems();
		});
	});

	$effect(() => {
		void virtualItems;
		void tick().then(measureVisibleItems);
	});

	$effect(() => {
		if (!onVisibleItemsChange) return;
		const visibleItemIds = virtualItems
			.map((virtualItem) => items[virtualItem.index]?.id)
			.filter((itemId): itemId is string => Boolean(itemId));
		if (areStringArraysEqual(visibleItemIds, lastVisibleItemIds)) return;
		lastVisibleItemIds = visibleItemIds;
		onVisibleItemsChange(visibleItemIds);
	});
</script>

{#if items.length === 0}
	<div
		class="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
	>
		{emptyMessage}
	</div>
{:else}
	<div bind:this={container} class={`${maxHeightClass} overflow-y-auto`}>
		<div class={`relative ${contentClass}`} style={`height: ${totalSize}px;`}>
			{#each virtualItems as virtualItem (virtualItem.key)}
				{@const item = items[virtualItem.index]}
				{#if item}
					<div
						use:measureVirtualItem
						data-virtual-item
						data-index={virtualItem.index}
						class="absolute top-0 left-0 w-full"
						style={`transform: translateY(${virtualItem.start}px);`}
					>
						<div style={`padding-bottom: ${itemGap}px;`}>
							<KeyPackageCard
								entry={item.entry}
								actionLabel={item.actionLabel}
								actionDisabled={item.actionDisabled}
								onAction={item.onAction}
								badge={item.badge}
								compact={item.compact}
								class={item.className}
							/>
						</div>
					</div>
				{/if}
			{/each}
		</div>
	</div>
{/if}
