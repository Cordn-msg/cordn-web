<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import type { MultiDeviceOwnerConfig } from '$lib/services/multiDevice.svelte';
	import {
		checkMultiDeviceHealth,
		repairMultiDeviceHealth,
		type MultiDeviceHealth as Health
	} from '$lib/services/multiDeviceRepair.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Wrench from '@lucide/svelte/icons/wrench';

	let { config }: { config: MultiDeviceOwnerConfig } = $props();
	let health = $state<Health | null>(null);
	let checking = $state(false);
	let repairing = $state(false);
	let message = $state('');
	let error = $state('');

	// A relay that failed its probe is unknown, not behind: it cannot be repaired.
	const unprobed = $derived(health?.relays.filter((r) => r.reason).length ?? 0);
	const repairable = $derived.by(() => {
		const current = health;
		if (!current) return false;
		return (
			current.missing.length > 0 ||
			(current.tipEvent !== null &&
				current.relays.some((r) => !r.reason && r.eventId !== current.tipEvent?.id))
		);
	});

	async function check() {
		checking = true;
		error = '';
		message = '';
		try {
			health = await checkMultiDeviceHealth(config);
			message = !health.tipEvent
				? 'No sync tip found on reachable relays'
				: health.lost.length
					? `${health.lost.length} document(s) were not found on any host`
					: repairable
						? 'Some backup copies are missing'
						: 'All reachable copies are current';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Health check failed';
		} finally {
			checking = false;
		}
	}

	async function repair() {
		repairing = true;
		error = '';
		try {
			const result = await repairMultiDeviceHealth(config);
			health = result.health;
			message = result.summary;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Repair failed';
		} finally {
			repairing = false;
		}
	}
</script>

<div class="space-y-3 rounded-lg border border-border p-3">
	<div>
		<h3 class="text-sm font-medium">Sync health</h3>
		<p class="text-xs text-muted-foreground">
			Check that your relays hold the latest sync tip and every document host has its sealed copies.
			Repair only re-uploads existing bytes; it does not change your chats.
		</p>
	</div>
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" size="sm" onclick={check} disabled={checking || repairing}>
			{#if checking}<Spinner class="mr-2 size-3.5" />{:else}<RefreshCw class="mr-2 size-3.5" />{/if}
			{checking ? 'Checking…' : 'Check health'}
		</Button>
		{#if repairable}
			<Button variant="outline" size="sm" onclick={repair} disabled={checking || repairing}>
				{#if repairing}<Spinner class="mr-2 size-3.5" />{:else}<Wrench class="mr-2 size-3.5" />{/if}
				{repairing ? 'Repairing…' : 'Repair missing copies'}
			</Button>
		{/if}
	</div>
	{#if health}
		{@const current = health}
		<div class="space-y-1 text-xs text-muted-foreground">
			{#if current.tipEvent}
				<p>
					{current.relays.filter((r) => r.eventId === current.tipEvent?.id).length}/{current.relays
						.length} relays have the newest tip
				</p>
				{#if unprobed > 0}
					<p>{unprobed} relay(s) could not be checked</p>
				{/if}
				{#each current.servers as server (server)}
					{@const rows = current.blobs.filter((b) => b.server === server)}
					<p>
						{#if rows.length > 0 && rows.every((b) => b.status === 0)}
							unreachable · {server}
						{:else if rows.length > 0 && rows.every((b) => b.status === 401 || b.status === 403)}
							gated · {server}
						{:else}
							{rows.filter((b) => b.present).length}/{rows.length} documents · {server}
						{/if}
					</p>
				{/each}
			{:else}
				<p>No sync tip found on reachable relays</p>
			{/if}
		</div>
	{/if}
	{#if message}<p class="text-xs text-muted-foreground">{message}</p>{/if}
	{#if error}<p class="text-xs text-destructive">{error}</p>{/if}
</div>
