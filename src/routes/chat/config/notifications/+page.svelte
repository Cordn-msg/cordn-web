<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import {
		isNativePlatform,
		getDeliveryConfig,
		setDeliveryConfig,
		type DeliveryConfig
	} from '$lib/services/nativeBridge';
	import { CordnBackground, type DeliveryMode } from 'cordn-background';
	import { App } from '@capacitor/app';
	import { toast } from 'svelte-sonner';
	import Bell from '@lucide/svelte/icons/bell';
	import Zap from '@lucide/svelte/icons/zap';
	import BatteryWarning from '@lucide/svelte/icons/battery-warning';
	import Check from '@lucide/svelte/icons/check';

	let config = $state<DeliveryConfig>(getDeliveryConfig());
	let exempted = $state<boolean | null>(null); // null = unknown (not yet queried)

	const modes: { mode: DeliveryMode; label: string; desc: string }[] = [
		{
			mode: 'off',
			label: 'Off',
			desc: 'No background checking. You only see new messages when you open Cordn.'
		},
		{
			mode: 'standard',
			label: 'Standard',
			desc: 'Checks about every 15 minutes. Battery-light and reliable.'
		},
		{
			mode: 'fast',
			label: 'Fast',
			desc: 'A background service checks every few minutes. More battery; a persistent “Cordn is syncing” notification shows.'
		}
	];

	const intervals = [1, 5, 10];

	async function pickMode(mode: DeliveryMode) {
		config = { ...config, mode };
		await setDeliveryConfig(config);
		toast.success(
			`Delivery set to ${mode === 'fast' ? 'Fast' : mode === 'standard' ? 'Standard' : 'Off'}`
		);
	}

	async function pickInterval(minutes: number) {
		config = { ...config, intervalMinutes: minutes };
		await setDeliveryConfig(config);
	}

	async function refreshExempted() {
		if (!isNativePlatform()) return;
		try {
			exempted = (await CordnBackground.isBatteryExempted()).exempted;
		} catch {
			exempted = null;
		}
	}

	async function requestExemption() {
		if (!isNativePlatform()) return;
		try {
			await CordnBackground.requestBatteryExemption();
		} catch {
			toast.error('Could not open the battery-optimization prompt');
		}
		// Re-query handled by the appStateChange listener below — it fires reliably when the user
		// returns from the system dialog (the old window 'focus' listener didn't fire across the
		// task boundary, and a fixed setTimeout fired while the dialog was still open).
	}

	$effect(() => {
		if (!isNativePlatform()) return;
		void refreshExempted();
		// The exemption dialog opens as a separate task; returning to Cordn (isActive:true) is the
		// reliable moment to re-query — works whether the user granted, denied, or backed out.
		const handlePromise = App.addListener('appStateChange', ({ isActive }) => {
			if (isActive) void refreshExempted();
		});
		return () => {
			void handlePromise.then((handle) => handle.remove());
		};
	});
</script>

<svelte:head>
	<title>Notifications | Cordn</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header
		class="flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6"
	>
		<ChatMobileSidebarButton />
		<div
			class="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted/30"
		>
			<Bell class="size-4" />
		</div>
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Notifications</h1>
			<p class="text-sm text-muted-foreground">
				How Cordn checks for new messages in the background.
			</p>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto grid max-w-3xl gap-6">
			{#if !isNativePlatform()}
				<Card.Root>
					<Card.Header>
						<Card.Title>Android app only</Card.Title>
						<Card.Description>
							Background delivery settings live in the Cordn Android app. The web app delivers new
							messages while it’s open.
						</Card.Description>
					</Card.Header>
				</Card.Root>
			{:else}
				<div class="space-y-3">
					{#each modes as m (m.mode)}
						<button
							type="button"
							class="flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-colors {config.mode ===
							m.mode
								? 'border-primary bg-primary/5'
								: 'border-border hover:bg-muted/30'}"
							onclick={() => pickMode(m.mode)}
						>
							<div
								class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border {config.mode ===
								m.mode
									? 'border-primary bg-primary text-primary-foreground'
									: 'border-muted-foreground/40'}"
							>
								{#if config.mode === m.mode}
									<Check class="size-3" />
								{/if}
							</div>
							<div class="min-w-0">
								<p class="font-medium">{m.label}</p>
								<p class="mt-0.5 text-sm text-muted-foreground">{m.desc}</p>
							</div>
						</button>
					{/each}
				</div>

				{#if config.mode === 'fast'}
					<Card.Root>
						<Card.Header>
							<Card.Title class="flex items-center gap-2">
								<Zap class="size-4" />
								How often?
							</Card.Title>
							<Card.Description>The background service polls at this interval.</Card.Description>
						</Card.Header>
						<Card.Content>
							<div class="grid grid-cols-3 gap-2">
								{#each intervals as minutes (minutes)}
									<button
										type="button"
										class="rounded-xl border px-3 py-3 text-center text-sm font-medium transition-colors {config.intervalMinutes ===
										minutes
											? 'border-primary bg-primary/10'
											: 'border-border hover:bg-muted/30'}"
										onclick={() => pickInterval(minutes)}
									>
										{minutes} min
									</button>
								{/each}
							</div>
							{#if config.intervalMinutes === 1}
								<p class="mt-2 text-xs text-muted-foreground">
									1-minute polling wakes the radio up to ~1440 times a day — noticeable battery use.
								</p>
							{/if}
						</Card.Content>
					</Card.Root>
				{/if}

				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2">
							<BatteryWarning class="size-4" />
							Battery optimization
						</Card.Title>
						<Card.Description>
							Some Android makers aggressively pause background apps. Exempting Cordn keeps
							notifications reliable, especially in Fast mode.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div class="flex items-center justify-between gap-3">
							<p class="text-sm">
								Status:
								<span class="font-medium">
									{#if exempted === null}
										Unknown
									{:else if exempted}
										Exempt (recommended)
									{:else}
										Not exempt
									{/if}
								</span>
							</p>
							{#if !exempted}
								<Button variant="outline" onclick={requestExemption}>Allow background</Button>
							{:else}
								<Button variant="ghost" onclick={requestExemption}>Review</Button>
							{/if}
						</div>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>How Cordn notifications work</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-2 text-xs text-muted-foreground">
						<p>
							Cordn checks for new encrypted messages on a schedule and shows a count-only
							notification — “N new in &lt;Group&gt;” with the group icon. Your messages are only
							decrypted when you open the app, so the background checker never sees message content.
						</p>
						<p>
							Notifications group by chat. Tapping one opens Cordn and downloads the full messages.
						</p>
					</Card.Content>
				</Card.Root>
			{/if}

			<div class="text-center">
				<a href={resolve('/chat/config')} class="text-sm text-muted-foreground hover:underline">
					Back to settings
				</a>
			</div>
		</div>
	</div>
</div>
