<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import QrCode from '$lib/components/QrCode.svelte';
	import Heart from '@lucide/svelte/icons/heart';
	import Zap from '@lucide/svelte/icons/zap';
	import Copy from '@lucide/svelte/icons/copy';
	import Lock from '@lucide/svelte/icons/lock';
	import Shield from '@lucide/svelte/icons/shield';
	import UserRound from '@lucide/svelte/icons/user-round';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { copyToClipboard } from '$lib/utils';
	import { DEFAULT_DONATION, type DonationConfig } from '$lib/news/feedItems';
	import {
		canSignWithActiveAccount,
		donationFlow,
		resetDonationFlow,
		startDonation
	} from '$lib/services/donations/donationFlow.svelte';

	let {
		open = $bindable(false),
		config = DEFAULT_DONATION
	}: { open?: boolean; config?: DonationConfig } = $props();

	const PRESETS = [
		{ sats: 21, emoji: '🌱' },
		{ sats: 420, emoji: '⚡' },
		{ sats: 1000, emoji: '☕' },
		{ sats: 2100, emoji: '🍺' },
		{ sats: 4200, emoji: '🍕' },
		{ sats: 10000, emoji: '🍔' },
		{ sats: 42000, emoji: '🚀' },
		{ sats: 210000, emoji: '🐋' }
	] as const;

	let selectedSats = $state(2100);
	let customSats = $state('');
	let message = $state('');
	let anonymous = $state(false);
	let publishEvent = $state(true);
	let customAmountOpen = $state(false);
	let advancedOpen = $state(false);

	const accountAvailable = $derived(canSignWithActiveAccount());
	const amountSats = $derived.by(() => {
		const custom = Number(customSats);
		return customSats !== '' && Number.isFinite(custom) && custom > 0
			? Math.floor(custom)
			: selectedSats;
	});
	const phase = $derived(donationFlow.phase);
	const isPreparing = $derived(phase.kind === 'preparing');

	let now = $state(Date.now());
	const remainingSeconds = $derived.by(() => {
		if (phase.kind !== 'awaiting-payment') return 0;
		return Math.max(0, Math.floor((phase.expiryAt - now) / 1000));
	});

	function formatSats(sats: number): string {
		if (sats >= 1000) {
			const k = sats / 1000;
			return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
		}
		return String(sats);
	}

	function formatCountdown(totalSeconds: number): string {
		if (totalSeconds >= 3600) {
			const days = Math.floor(totalSeconds / 86400);
			const hours = Math.floor((totalSeconds % 86400) / 3600);
			const mins = Math.floor((totalSeconds % 3600) / 60);
			if (days > 0) return `${days}d ${hours}h ${mins}m`;
			return `${hours}h ${mins}m`;
		}
		const mins = Math.floor(totalSeconds / 60);
		const secs = totalSeconds % 60;
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}

	function pickPreset(sats: number) {
		selectedSats = sats;
		customSats = '';
	}

	async function onDonate() {
		await startDonation({
			lnAddress: config.lnAddress,
			recipientPubkey: config.recipientPubkey,
			amountSats,
			message,
			anonymous: publishEvent && (anonymous || !accountAvailable),
			publishEvent
		});
	}

	async function copyInvoice() {
		if (phase.kind === 'awaiting-payment') {
			await copyToClipboard(phase.invoice);
		}
	}

	// Fresh form on open; cancel any in-flight donation (and free the relay
	// subscription) on close. Cancelling is silent — it never surfaces an error.
	$effect(() => {
		if (open) {
			selectedSats = 2100;
			customSats = '';
			message = '';
			anonymous = !accountAvailable;
			publishEvent = true;
			customAmountOpen = false;
			advancedOpen = false;
		} else {
			resetDonationFlow();
		}
	});

	// Live countdown while awaiting payment.
	$effect(() => {
		if (phase.kind !== 'awaiting-payment') return;
		const interval = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(interval);
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="gap-4 p-4 sm:max-w-md sm:gap-6 sm:p-6">
		{#if phase.kind === 'awaiting-payment'}
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<Zap class="size-4" />
					Scan to donate {formatSats(phase.amountSats)} sats
				</Dialog.Title>
				<Dialog.Description>
					Open your Lightning wallet and scan the code, or copy the invoice.
				</Dialog.Description>
			</Dialog.Header>

			<div class="flex min-w-0 flex-col items-center gap-3 py-2">
				<QrCode data={`lightning:${phase.invoice}`} size={220} />
				<Button variant="outline" class="w-full" onclick={copyInvoice}>
					<Copy class="size-4" />
					Copy invoice
				</Button>
				<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
					{#if remainingSeconds > 0}
						Invoice expires in
						<span
							class={`font-medium ${remainingSeconds < 60 ? 'text-destructive' : 'text-foreground'}`}
						>
							{formatCountdown(remainingSeconds)}
						</span>
					{:else}
						<span class="font-medium text-destructive">Invoice expired</span>
					{/if}
				</p>
				{#if !phase.confirmable}
					<p class="text-center text-xs text-muted-foreground/80">
						Direct invoice — not tracked on Nostr, so it won't auto-confirm.
					</p>
				{/if}
			</div>

			<Dialog.Footer>
				<Button variant="outline" class="w-full" onclick={resetDonationFlow}>
					{phase.confirmable ? 'Cancel' : 'Done'}
				</Button>
			</Dialog.Footer>
		{:else if phase.kind === 'confirmed'}
			<div class="flex flex-col items-center gap-3 py-6 text-center">
				<div
					class="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
				>
					<Check class="size-6" />
				</div>
				<div>
					<Dialog.Title class="text-base font-semibold">Thank you for your support!</Dialog.Title>
					<Dialog.Description>
						Your {formatSats(phase.amountSats)} sat zap was received.
					</Dialog.Description>
				</div>
			</div>
			<Dialog.Footer>
				<Button class="w-full" onclick={() => (open = false)}>Done</Button>
			</Dialog.Footer>
		{:else}
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<Heart class="size-4" />
					{config.dialogTitle}
				</Dialog.Title>
				<Dialog.Description>{config.dialogDescription}</Dialog.Description>
			</Dialog.Header>

			{#if phase.kind === 'failed'}
				<div
					class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
				>
					{phase.error}
				</div>
			{/if}

			<div class="min-w-0 space-y-3 sm:space-y-4">
				{#snippet collapsibleTrigger(label: string, isOpen: boolean)}
					<Collapsible.Trigger
						class="flex w-full items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						{label}
						<ChevronDown class={`size-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
					</Collapsible.Trigger>
				{/snippet}

				<div class="grid grid-cols-3 gap-2 sm:grid-cols-4">
					{#each PRESETS as preset (preset.sats)}
						<Button
							class="w-full"
							variant={customSats === '' && selectedSats === preset.sats ? 'default' : 'outline'}
							size="sm"
							onclick={() => pickPreset(preset.sats)}
						>
							<span aria-hidden="true">{preset.emoji}</span>
							{formatSats(preset.sats)}
						</Button>
					{/each}
				</div>

				<Collapsible.Root bind:open={customAmountOpen}>
					{@render collapsibleTrigger('Custom amount', customAmountOpen)}
					<Collapsible.Content>
						<div class="mt-2">
							<Input
								id="donation-custom"
								type="number"
								min="1"
								step="1"
								placeholder="e.g. 500000 sats"
								bind:value={customSats}
							/>
						</div>
					</Collapsible.Content>
				</Collapsible.Root>

				<div
					class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
				>
					<div class="flex min-w-0 items-center gap-2">
						{#if publishEvent}
							<Zap class="size-4 text-muted-foreground" />
						{:else}
							<Lock class="size-4 text-muted-foreground" />
						{/if}
						<div class="min-w-0">
							<p class="text-sm leading-tight font-medium">Public Nostr zap</p>
							<p class="truncate text-xs text-muted-foreground">
								{#if publishEvent}
									Publishes a zap event (shown in supporters)
								{:else}
									Private Lightning invoice, no event
								{/if}
							</p>
						</div>
					</div>
					<Switch bind:checked={publishEvent} />
				</div>

				{#if publishEvent}
					<div class="space-y-1.5">
						<Label for="donation-message" class="text-xs text-muted-foreground">
							Message <span class="text-muted-foreground/70">(optional)</span>
						</Label>
						<Textarea
							id="donation-message"
							rows={2}
							maxlength={280}
							placeholder="Add a note with your zap…"
							bind:value={message}
						/>
					</div>

					<Collapsible.Root bind:open={advancedOpen}>
						{@render collapsibleTrigger('Advanced', advancedOpen)}
						<Collapsible.Content>
							<div
								class="mt-2 flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
							>
								<div class="flex min-w-0 items-center gap-2">
									{#if anonymous}
										<Shield class="size-4 text-muted-foreground" />
									{:else}
										<UserRound class="size-4 text-muted-foreground" />
									{/if}
									<div class="min-w-0">
										<p class="text-sm leading-tight font-medium">Anonymous zap</p>
										<p class="truncate text-xs text-muted-foreground">
											{#if !accountAvailable}
												Sign in to zap as yourself
											{:else if anonymous}
												Signed with an ephemeral key
											{:else}
												Signed as your account
											{/if}
										</p>
									</div>
								</div>
								<Switch bind:checked={anonymous} disabled={!accountAvailable} />
							</div>
						</Collapsible.Content>
					</Collapsible.Root>
				{/if}
			</div>

			<Dialog.Footer>
				<Button class="w-full" onclick={onDonate} disabled={amountSats <= 0 || isPreparing}>
					{#if isPreparing}
						<LoaderCircle class="size-4 animate-spin" />
					{:else}
						<Zap class="size-4" />
					{/if}
					Donate {formatSats(amountSats)} sats
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
