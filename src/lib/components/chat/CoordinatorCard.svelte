<script lang="ts">
	import { resolve } from '$app/paths';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { setDefaultChatCoordinator } from '$lib/services/chatCoordinators.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { listChatKeyPackages } from '$lib/services/chatKeyPackages.svelte';
	import CoordinatorPurgeDialog from './CoordinatorPurgeDialog.svelte';
	import Check from '@lucide/svelte/icons/check';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	export interface CoordinatorCardEntry {
		pubkey: string;
		label: string;
		color: string;
		relays: string[];
		isDefault: boolean;
		lastUsedAt?: number;
	}

	let { coordinator }: { coordinator: CoordinatorCardEntry } = $props();

	let showPurgeDialog = $state(false);

	const groupCount = $derived(
		listChatGroups().filter((group) => group.coordinatorKey === coordinator.pubkey).length
	);
	const publishedCount = $derived(
		listChatKeyPackages().filter((entry) =>
			entry.publishedCoordinatorKeys.includes(coordinator.pubkey)
		).length
	);
</script>

<Card.Root>
	<Card.Content class="pt-6">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0 space-y-2">
				<div class="flex items-center gap-2">
					<span
						class="h-3 w-3 rounded-full border border-border"
						style={`background-color: ${coordinator.color};`}
						aria-hidden="true"
					></span>
					<p class="truncate font-medium">{coordinator.label}</p>
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
					{coordinator.relays.length > 0 ? coordinator.relays.join(' · ') : 'No saved relays'}
				</p>
			</div>
			<div class="shrink-0">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								type="button"
								variant="ghost"
								size="icon-sm"
								class="rounded-lg text-muted-foreground hover:text-foreground"
								aria-label="Coordinator actions"
								title="Coordinator actions"
							>
								<EllipsisVertical class="size-4" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-52">
						{#if !coordinator.isDefault}
							<DropdownMenu.Item
								onclick={() => setDefaultChatCoordinator(coordinator.pubkey)}
								class="gap-2"
							>
								<Check class="size-4" />
								<span>Set as default</span>
							</DropdownMenu.Item>
						{/if}
						<DropdownMenu.Item
							onclick={() => (showPurgeDialog = true)}
							class="gap-2 text-destructive data-[highlighted]:text-destructive"
						>
							<Trash2 class="size-4" />
							<span>Remove</span>
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		</div>

		<div class="mt-4 grid gap-3 sm:grid-cols-3">
			<div class="rounded-xl border border-border/70 px-3 py-2">
				<p class="text-[11px] tracking-wide text-muted-foreground uppercase">Groups</p>
				<p class="text-lg font-semibold">{groupCount}</p>
			</div>
			<div class="rounded-xl border border-border/70 px-3 py-2">
				<p class="text-[11px] tracking-wide text-muted-foreground uppercase">Published KPs</p>
				<p class="text-lg font-semibold">{publishedCount}</p>
			</div>
			<div class="rounded-xl border border-border/70 px-3 py-2">
				<p class="text-[11px] tracking-wide text-muted-foreground uppercase">Last used</p>
				<p class="text-sm font-medium">
					{coordinator.lastUsedAt ? new Date(coordinator.lastUsedAt).toLocaleString() : 'Not yet'}
				</p>
			</div>
		</div>

		<div class="mt-4 flex flex-wrap gap-2">
			<Button
				href={resolve('/chat/coordinators/[coordinatorKey]', {
					coordinatorKey: coordinator.pubkey
				})}>Open detail</Button
			>
			<Button href={`${resolve('/chat/coordinators')}?c=${coordinator.pubkey}`} variant="outline"
				>Edit</Button
			>
			<Button
				href={`${resolve('/chat/create-group')}?coordinator=${coordinator.pubkey}`}
				variant="outline">Create group</Button
			>
			<Button href={resolve('/chat/config/key-packages')} variant="outline"
				>Open key packages</Button
			>
		</div>
	</Card.Content>
</Card.Root>

<CoordinatorPurgeDialog
	bind:open={showPurgeDialog}
	pubkey={coordinator.pubkey}
	label={coordinator.label}
/>
