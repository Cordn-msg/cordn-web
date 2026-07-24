<script lang="ts">
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import X from '@lucide/svelte/icons/x';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { isMultiDeviceActive } from '$lib/services/multiDevice.svelte';
	import { listKnownCoordinatorKeys } from '$lib/services/chatCoordinators.svelte';
	import {
		migrationBannerStore,
		checkMigrationBanner,
		isMigrationDismissed,
		dismissMigrationBanner
	} from '$lib/services/migrationBanner.svelte';

	// Probe once per login / coordinator-set change. Idempotent via the fingerprint guard inside
	// checkMigrationBanner, so reading the coordinator list here just re-tracks the dependency.
	$effect(() => {
		void $activeAccount?.pubkey;
		void listKnownCoordinatorKeys().length;
		void checkMigrationBanner();
	});

	// Self-hides once groups exist (linked or restored) or multi-device is active. Take-over is
	// deliberately not offered — this is guidance only.
	const visible = $derived(
		migrationBannerStore.detected &&
			listChatGroups().length === 0 &&
			!isMultiDeviceActive() &&
			!isMigrationDismissed($activeAccount?.pubkey)
	);
</script>

{#if visible}
	<div
		class="flex flex-col gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 text-sm sm:flex-row sm:items-center"
		role="status"
		aria-live="polite"
	>
		<Smartphone class="size-4 shrink-0" />
		<span class="min-w-0 flex-1">
			<span class="font-medium">New device detected.</span>
			<span class="text-muted-foreground">
				Link your devices to keep groups in sync across both, or restore a backup to bring them
				here.
			</span>
		</span>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm" href={`${resolve('/chat/config/multi-device')}?tab=link`}>
				Link devices
			</Button>
			<Button size="sm" variant="outline" href={`${resolve('/chat/config/backup')}?tab=restore`}>
				Restore backup
			</Button>
			<button
				type="button"
				class="grid size-7 place-items-center rounded-full text-muted-foreground transition-opacity hover:opacity-100"
				aria-label="Dismiss new-device reminder"
				onclick={dismissMigrationBanner}
			>
				<X class="size-4" />
			</button>
		</div>
	</div>
{/if}
