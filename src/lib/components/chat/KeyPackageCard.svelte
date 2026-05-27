<script lang="ts">
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import { cn, copyToClipboard } from '$lib/utils';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import type { Snippet } from 'svelte';
	import type { AvailableKeyPackage } from '$lib/contracts';
	import type { CoordinatorAvailableKeyPackage } from '$lib/services/chatGroups.svelte';
	import type { StoredKeyPackageRecord } from '$lib/services/chatKeyPackages.svelte';

	type KeyPackageCardData = {
		ref: string;
		label?: string;
		pubkey?: string;
		publishedAt?: number;
		createdAt?: number;
		isLastResort?: boolean;
	};

	let {
		entry,
		actionLabel,
		onAction,
		actionDisabled = false,
		badge,
		compact = false,
		details,
		class: className = ''
	}: {
		entry: StoredKeyPackageRecord | AvailableKeyPackage | CoordinatorAvailableKeyPackage;
		actionLabel?: string;
		onAction?: () => void | Promise<void>;
		actionDisabled?: boolean;
		badge?: string;
		compact?: boolean;
		details?: Snippet;
		class?: string;
	} = $props();

	const normalized = $derived.by<KeyPackageCardData>(() => {
		if ('keyPackageRef' in entry) {
			return {
				ref: entry.keyPackageRef,
				label: 'label' in entry ? entry.label : undefined,
				pubkey:
					'stablePubkey' in entry
						? entry.stablePubkey
						: 'ownerPubkey' in entry
							? entry.ownerPubkey
							: undefined,
				publishedAt: 'publishedAt' in entry ? entry.publishedAt : undefined,
				createdAt: 'createdAt' in entry ? entry.createdAt : undefined,
				isLastResort: entry.isLastResort
			};
		}

		return {
			ref: entry.kp_ref,
			pubkey: entry.pk,
			publishedAt: entry.at,
			isLastResort: entry.last_resort
		};
	});

	const timestampLabel = $derived.by(() => {
		const timestamp = normalized.publishedAt ?? normalized.createdAt;
		if (!timestamp) return '';
		return new Date(timestamp).toLocaleString();
	});

	async function handleCopyRef() {
		await copyToClipboard(normalized.ref);
	}
</script>

<div
	class={cn(
		'rounded-xl border border-border bg-background/60 px-4 py-3',
		compact ? 'space-y-2' : 'space-y-3',
		className
	)}
>
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0 flex-1 space-y-2">
			{#if normalized.pubkey}
				<ProfileCard pubkey={normalized.pubkey} mode="inline" showInlineAvatar={true} />
			{/if}
			<div>
				<button
					type="button"
					class="text-left font-mono text-xs break-all text-muted-foreground transition-colors hover:text-foreground"
					onclick={handleCopyRef}
				>
					{normalized.ref}
				</button>
			</div>
		</div>

		{#if badge}
			<span class="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
				{badge}
			</span>
		{/if}
	</div>

	<div
		class="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
	>
		<div class="flex flex-wrap items-center gap-2">
			{#if normalized.isLastResort}
				<span class="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
					<CircleAlert class="size-3" />
					Last resort
				</span>
			{/if}
			{#if timestampLabel}
				<span>{timestampLabel}</span>
			{/if}
		</div>

		{#if actionLabel && onAction}
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="w-full sm:w-auto"
				onclick={onAction}
				disabled={actionDisabled}
			>
				{actionLabel}
			</Button>
		{/if}
	</div>

	{#if details}
		<div class="text-xs text-muted-foreground">
			{@render details()}
		</div>
	{/if}
</div>
