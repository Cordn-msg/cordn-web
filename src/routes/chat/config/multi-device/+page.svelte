<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { Spinner } from '$lib/components/ui/spinner';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import QrCode from '$lib/components/QrCode.svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { defaultRelays } from '$lib/services/relay-pool';
	import { BLOSSOM_SERVERS, DEFAULT_BLOSSOM_SERVER } from '$lib/constants/chat';
	import {
		enableMultiDevice,
		disableMultiDevice,
		rotateMultiDeviceKey,
		setMultiDeviceRelays,
		getMultiDeviceConfig,
		getMultiDeviceBlossomServer,
		setMultiDeviceBlossomServer,
		isCustomMultiDeviceBlossomServer,
		buildConnectionString,
		linkDeviceFromConnectionString,
		type MultiDeviceOwnerConfig,
		type LinkResult
	} from '$lib/services/multiDevice.svelte';
	import { toast } from 'svelte-sonner';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import LinkIcon from '@lucide/svelte/icons/link';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Copy from '@lucide/svelte/icons/copy';
	import Server from '@lucide/svelte/icons/server';

	let tab = $state<'add' | 'link'>('add');

	// Live config; re-read on every reactive tick so enable/disable/rotate reflect.
	let config = $state<MultiDeviceOwnerConfig | undefined>(undefined);
	let connectionString = $state('');
	let relaysDraft = $state('');
	// Blossom server selector state (mirrors the media config page).
	const BLOSSOM_CUSTOM = '__custom__';
	let blossomServer = $state(DEFAULT_BLOSSOM_SERVER);
	let blossomCustomUrl = $state('');
	let rotating = $state(false);
	let linking = $state(false);
	let linkResult = $state<LinkResult | null>(null);
	let linkInput = $state('');
	let scanning = $state(false);

	$effect(() => {
		// Track the active account so config reloads on identity switch.
		// IMPORTANT: read localStorage into a local const and only THEN assign to
		// $state — an $effect that reads and writes the same $state loops forever.
		void $activeAccount?.pubkey;
		const cfg = getMultiDeviceConfig();
		config = cfg;
		connectionString = cfg ? buildConnectionString(cfg) : '';
		relaysDraft = cfg ? cfg.relays.join('\n') : defaultRelays.join('\n');
		blossomServer = getMultiDeviceBlossomServer();
		blossomCustomUrl = isCustomMultiDeviceBlossomServer() ? blossomServer : '';
	});

	const enabled = $derived(config?.enabled === true);

	const blossomSelectedOption = $derived(
		BLOSSOM_SERVERS.includes(blossomServer as (typeof BLOSSOM_SERVERS)[number])
			? blossomServer
			: BLOSSOM_CUSTOM
	);

	function handleBlossomSelect(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		if (value === BLOSSOM_CUSTOM) {
			blossomServer = isCustomMultiDeviceBlossomServer() ? getMultiDeviceBlossomServer() : '';
			blossomCustomUrl = blossomServer;
		} else {
			blossomServer = value;
			setMultiDeviceBlossomServer(value);
			config = getMultiDeviceConfig();
			if (config) connectionString = buildConnectionString(config);
			toast.success('Blossom server updated');
		}
	}

	function commitBlossomCustom() {
		if (blossomCustomUrl.trim()) {
			setMultiDeviceBlossomServer(blossomCustomUrl);
			blossomServer = getMultiDeviceBlossomServer();
			config = getMultiDeviceConfig();
			if (config) connectionString = buildConnectionString(config);
			toast.success('Blossom server updated');
		}
	}

	async function handleEnable() {
		console.debug('[multi-device][page] handleEnable', {
			relayDraftLines: relaysDraft.split('\n').length
		});
		const relays = parseRelays(relaysDraft);
		try {
			config = enableMultiDevice(relays);
			connectionString = buildConnectionString(config);
			console.debug('[multi-device][page] enabled OK', { enabled: config.enabled });
			toast.success('Multi-device sync enabled');
		} catch (error) {
			console.warn('[multi-device][page] enable failed', error);
			toast.error(error instanceof Error ? error.message : 'Could not enable multi-device');
		}
	}

	function handleDisable() {
		console.debug('[multi-device][page] handleDisable');
		disableMultiDevice();
		config = getMultiDeviceConfig();
		toast.success('Multi-device sync disabled');
	}

	async function handleRotate() {
		if (
			!confirm(
				'Rotate the multi-device key? Every linked device must be re-linked with the new connection string.'
			)
		) {
			return;
		}
		rotating = true;
		try {
			config = rotateMultiDeviceKey();
			connectionString = buildConnectionString(config);
			toast.success('Multi-device key rotated — re-link your other devices');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not rotate the key');
		} finally {
			rotating = false;
		}
	}

	function handleSaveRelays() {
		const relays = parseRelays(relaysDraft);
		if (relays.length === 0) {
			toast.error('Add at least one relay');
			return;
		}
		setMultiDeviceRelays(relays);
		config = getMultiDeviceConfig();
		if (config) connectionString = buildConnectionString(config);
		toast.success('Relays updated');
	}

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(connectionString);
			toast.success('Connection string copied');
		} catch {
			toast.error('Could not copy — select and copy manually');
		}
	}

	async function handleLink() {
		if (!linkInput.trim()) {
			toast.error('Paste a connection string or scan its QR code');
			return;
		}
		linking = true;
		linkResult = null;
		try {
			linkResult = await linkDeviceFromConnectionString(linkInput.trim());
			toast.success(
				`Linked — ${linkResult.seeded} group${linkResult.seeded === 1 ? '' : 's'} seeded`
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not link this device');
		} finally {
			linking = false;
		}
	}

	function parseRelays(text: string): string[] {
		return text
			.split(/\s+|,|\n/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header
		class="flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6"
	>
		<ChatMobileSidebarButton />
		<div
			class="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted/30"
		>
			<Smartphone class="size-4" />
		</div>
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Multi-device sync</h1>
			<p class="text-sm text-muted-foreground">
				Share your groups across devices of the same identity.
			</p>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto grid max-w-3xl gap-6">
			{#if !$activeAccount}
				<Card.Root>
					<Card.Header>
						<Card.Title>Log in required</Card.Title>
						<Card.Description>Multi-device sync is scoped to the active identity.</Card.Description>
					</Card.Header>
					<Card.Content>
						<div class="space-y-3">
							<p class="text-sm text-muted-foreground">
								Devices share one MLS leaf per group. Log in with the same identity on every device.
							</p>
							<AccountLoginDialog />
						</div>
					</Card.Content>
				</Card.Root>
			{:else}
				<!-- Enable / disable -->
				<Card.Root>
					<Card.Header>
						<Card.Title>Sync status</Card.Title>
						<Card.Description>
							When enabled, your groups' MLS state is sealed and published so other devices can
							adopt it.
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-4">
						<div class="flex items-center justify-between rounded-lg border border-border p-3">
							<div>
								<p class="text-sm font-medium">{enabled ? 'Enabled' : 'Disabled'}</p>
								<p class="text-xs text-muted-foreground">
									{enabled && config
										? `Tip relays: ${config.relays.length} · Last published: ${config.lastPublishedAddress ? 'yes' : 'never'}`
										: 'No sync activity.'}
								</p>
							</div>
							<Switch
								checked={enabled}
								onCheckedChange={(next) => {
									console.debug('[multi-device][page] switch toggled', next);
									return next ? handleEnable() : handleDisable();
								}}
							/>
						</div>

						{#if enabled}
							<div class="space-y-2">
								<Label for="md-relays">Tip relays (one per line)</Label>
								<textarea
									id="md-relays"
									class="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
									bind:value={relaysDraft}
								></textarea>
								<p class="text-xs text-muted-foreground">
									The replaceable tip event is published here. Newly-linked devices inherit this
									list.
								</p>
								<Button variant="outline" onclick={handleSaveRelays} class="w-full"
									>Save relays</Button
								>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>

				{#if enabled}
					<Card.Root>
						<Card.Header>
							<Card.Title>Document storage</Card.Title>
							<Card.Description>
								The Blossom server that holds your sealed sync document. Linked devices fetch it
								from here, falling back to the other presets if this one is unreachable.
							</Card.Description>
						</Card.Header>
						<Card.Content>
							<div class="space-y-2">
								<Label for="md-blossom">Server</Label>
								<div class="relative">
									<span
										class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
									>
										<Server class="size-4" />
									</span>
									<select
										id="md-blossom"
										class="h-10 w-full appearance-none rounded-md border border-input bg-background pr-3 pl-9 text-sm ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
										value={blossomSelectedOption}
										onchange={handleBlossomSelect}
									>
										{#each BLOSSOM_SERVERS as server (server)}
											<option value={server}>{server}</option>
										{/each}
										<option value={BLOSSOM_CUSTOM}>Custom…</option>
									</select>
								</div>
							</div>

							{#if blossomSelectedOption === BLOSSOM_CUSTOM}
								<div class="mt-3 space-y-2">
									<Label for="md-blossom-custom">Custom server URL</Label>
									<Input
										id="md-blossom-custom"
										bind:value={blossomCustomUrl}
										placeholder="https://your-blossom-server.example/"
										onblur={commitBlossomCustom}
										onkeydown={(e) => e.key === 'Enter' && commitBlossomCustom()}
									/>
									<p class="text-xs text-muted-foreground">
										Defaults to {DEFAULT_BLOSSOM_SERVER} when left blank.
									</p>
								</div>
							{/if}
						</Card.Content>
					</Card.Root>
				{/if}

				{#if enabled}
					<!-- Tab navigation -->
					<div class="flex space-x-1 rounded-lg bg-muted p-1">
						<button
							class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab ===
							'add'
								? 'bg-background shadow-sm'
								: 'hover:bg-muted-foreground/10'}"
							onclick={() => (tab = 'add')}
						>
							Add a device
						</button>
						<button
							class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab ===
							'link'
								? 'bg-background shadow-sm'
								: 'hover:bg-muted-foreground/10'}"
							onclick={() => (tab = 'link')}
						>
							Link this device
						</button>
					</div>

					{#if tab === 'add'}
						<Card.Root>
							<Card.Header>
								<Card.Title>Connection string</Card.Title>
								<Card.Description>
									Scan this on another device logged in as the same identity. It carries no private
									keys — only a locator and a write capability for the tip.
								</Card.Description>
							</Card.Header>
							<Card.Content class="space-y-4">
								<div class="flex justify-center rounded-lg border border-border bg-white p-4">
									<div class="w-full max-w-[240px]">
										<QrCode data={connectionString} size={240} />
									</div>
								</div>

								<div class="space-y-2">
									<Label>Or copy this string</Label>
									<div class="flex gap-2">
										<Input value={connectionString} readonly class="font-mono text-xs" />
										<Button variant="outline" onclick={handleCopy}>
											<Copy class="mr-2 size-4" />
											Copy
										</Button>
									</div>
								</div>

								<div
									class="space-y-2 rounded-lg border border-border p-3 text-xs text-muted-foreground"
								>
									<p>
										<span class="font-medium text-foreground">How it works:</span>
										Your groups' MLS state is sealed to your own npub (NIP-44) and stored on Blossom.
										Other devices fetch it via an opaque Nostr tip pointer, decrypt it, and adopt the
										shared leaf.
									</p>
									<p>
										<span class="font-medium text-foreground">Shared-leaf model:</span>
										all your devices present as one member per group. Removing the user removes every
										device; there is no per-device revocation.
									</p>
								</div>

								<Button variant="outline" onclick={handleRotate} disabled={rotating} class="w-full">
									{#if rotating}
										<Spinner class="mr-2 size-4" />
										Rotating…
									{:else}
										<RefreshCw class="mr-2 size-4" />
										Rotate connection string
									{/if}
								</Button>
								<p class="text-xs text-muted-foreground">
									Use rotation if this string leaked. Every previously-linked device must be
									re-linked.
								</p>
							</Card.Content>
						</Card.Root>
					{:else}
						<Card.Root>
							<Card.Header>
								<Card.Title>Link this device</Card.Title>
								<Card.Description>
									Paste the connection string from another device, or scan its QR code.
								</Card.Description>
							</Card.Header>
							<Card.Content class="space-y-4">
								<div class="space-y-2">
									<Label for="md-link-input">Connection string</Label>
									<Input
										id="md-link-input"
										bind:value={linkInput}
										placeholder="Paste the connection string here"
										class="font-mono text-xs"
									/>
								</div>

								<Button onclick={handleLink} disabled={linking} class="w-full">
									{#if linking}
										<Spinner class="mr-2 size-4" />
										Linking…
									{:else}
										<LinkIcon class="mr-2 size-4" />
										Link device
									{/if}
								</Button>

								<div class="flex items-center gap-2 text-xs text-muted-foreground">
									<div class="h-px flex-1 bg-border"></div>
									<span>or</span>
									<div class="h-px flex-1 bg-border"></div>
								</div>

								{#if scanning}
									<div class="space-y-2">
										<QrScanner
											onResult={(data) => {
												linkInput = data;
												scanning = false;
											}}
										/>
										<Button variant="outline" onclick={() => (scanning = false)} class="w-full">
											Cancel scan
										</Button>
									</div>
								{:else}
									<Button variant="outline" onclick={() => (scanning = true)} class="w-full">
										Scan QR code
									</Button>
								{/if}

								{#if linkResult}
									<div class="rounded-lg border border-border bg-muted/30 p-3 text-sm">
										<p class="font-medium">Linked successfully</p>
										<p class="text-muted-foreground">
											{linkResult.seeded} group{linkResult.seeded === 1 ? '' : 's'} seeded,
											{linkResult.fastForwarded} fast-forwarded. New groups will sync as they're added.
										</p>
									</div>
								{/if}
							</Card.Content>
						</Card.Root>
					{/if}
				{/if}

				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2">
							<ShieldAlert class="size-4" />
							Security notes
						</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-2 text-xs text-muted-foreground">
						<p>
							Group state is sealed (NIP-44) to your own npub — only a device that can sign as you
							can decrypt it.
						</p>
						<p>
							The tip pointer is published under an ephemeral key so it does not reveal your
							identity or Cordn usage to passive relay observers.
						</p>
						<p>
							A leaked connection string can only deny service (re-point the tip to a stale
							document); it cannot forge a valid pointer or decrypt your groups.
						</p>
					</Card.Content>
				</Card.Root>

				<div class="text-center">
					<a href={resolve('/chat/config')} class="text-sm text-muted-foreground hover:underline">
						Back to settings
					</a>
				</div>
			{/if}
		</div>
	</div>
</div>
