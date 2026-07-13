<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { Spinner } from '$lib/components/ui/spinner';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import QrCode from '$lib/components/QrCode.svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import MultiDeviceDevPanel from '$lib/components/chat/MultiDeviceDevPanel.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { page } from '$app/state';
	import { BLOSSOM_SERVERS, DEFAULT_BLOSSOM_SERVER } from '$lib/constants/chat';
	import {
		enableMultiDevice,
		disableMultiDevice,
		rotateMultiDeviceKey,
		setMultiDeviceRelays,
		getMultiDeviceConfig,
		setMultiDeviceBlossomServers,
		DEFAULT_BLOSSOM_SERVERS,
		DEFAULT_MULTI_DEVICE_RELAYS,
		buildConnectionString,
		linkDeviceFromConnectionString,
		reconcileMultiDeviceNow,
		mdProgress,
		type MultiDeviceOwnerConfig,
		type LinkResult
	} from '$lib/services/multiDevice.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import { toast } from 'svelte-sonner';
	import { SvelteSet } from 'svelte/reactivity';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import LinkIcon from '@lucide/svelte/icons/link';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Copy from '@lucide/svelte/icons/copy';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Download from '@lucide/svelte/icons/download';

	let tab = $state<'add' | 'link'>(page.url.searchParams.get('tab') === 'link' ? 'link' : 'add');

	// Live config; re-read on every reactive tick so enable/disable/rotate reflect.
	let config = $state<MultiDeviceOwnerConfig | undefined>(undefined);
	let connectionString = $state('');
	let relaysDraft = $state('');
	// Blossom redundancy: a checked subset of presets, ordered by BLOSSOM_SERVERS.
	// The first checked entry is the primary (read path tries them in order).
	// SvelteSet is self-reactive, so no $state wrap — mutate in place.
	let blossomChecked = new SvelteSet<string>();
	let rotating = $state(false);
	let resyncing = $state(false);
	let linking = $state(false);
	let linkResult = $state<LinkResult | null>(null);
	let linkInput = $state('');
	let scanning = $state(false);
	let advancedOpen = $state(false);
	// ponytail: session-only — not persisted. Off on every page load by design,
	// switched on deliberately when you actually want the dev panel.
	let devMode = $state(false);

	$effect(() => {
		// Track the active account so config reloads on identity switch.
		// IMPORTANT: read localStorage into a local const and only THEN assign to
		// $state — an $effect that reads and writes the same $state loops forever.
		void $activeAccount?.pubkey;
		const cfg = getMultiDeviceConfig();
		config = cfg;
		connectionString = cfg ? buildConnectionString(cfg) : '';
		relaysDraft = (cfg?.relays ?? DEFAULT_MULTI_DEVICE_RELAYS).join('\n');
		const servers = cfg ? cfg.blossomServers : DEFAULT_BLOSSOM_SERVERS;
		blossomChecked.clear();
		for (const s of servers) blossomChecked.add(s);
	});

	const hasConfig = $derived(!!config);
	const enabled = $derived(config?.enabled === true);
	// Hides the "already set up elsewhere?" hint once this device has groups.
	const hasLocalGroups = $derived(listChatGroups().length > 0);

	// Every enabled device both reads and writes (mesh of equal peers, spec §11),
	// so the only honest status distinction is active / paused / not-set-up.
	const statusLabel = $derived(
		!hasConfig ? 'Not set up yet' : !enabled ? 'Sync paused' : 'Sync active'
	);

	function toggleBlossom(server: string, checked: boolean) {
		if (checked) {
			blossomChecked.add(server);
		} else if (blossomChecked.size > 1) {
			// Keep at least one host so the document is always reachable.
			blossomChecked.delete(server);
		} else {
			toast.error('Keep at least one Blossom server for redundancy');
		}
	}

	function blossomServersInOrder(): string[] {
		// Primary = first preset (in declared order) that is checked; preserves a
		// stable priority without asking the user to order the list manually.
		return BLOSSOM_SERVERS.filter((s) => blossomChecked.has(s));
	}

	async function handleSetup() {
		const relays = parseRelays(relaysDraft);
		if (relays.length === 0) {
			toast.error('Add at least one relay');
			return;
		}
		const blossom = blossomServersInOrder();
		try {
			config = enableMultiDevice(relays, blossom);
			connectionString = buildConnectionString(config);
			toast.success(hasConfig ? 'Sync resumed' : 'Multi-device sync enabled');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not enable multi-device');
		}
	}

	function handlePause() {
		disableMultiDevice();
		config = getMultiDeviceConfig();
		toast.success('Multi-device sync paused');
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
			config = await rotateMultiDeviceKey();
			connectionString = buildConnectionString(config);
			toast.success('Multi-device key rotated — re-link your other devices');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not rotate the key');
		} finally {
			rotating = false;
		}
	}

	async function handleResync() {
		resyncing = true;
		try {
			const counts = await reconcileMultiDeviceNow();
			if (!counts) {
				toast.error('Sync is off, or no group document was found');
			} else {
				toast.success(
					`Re-synced — ${counts.fastForwarded} caught up, ${counts.seeded} new, ${counts.skipped} already current`
				);
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not re-sync');
		} finally {
			resyncing = false;
		}
	}

	function handleSaveAdvanced() {
		const relays = parseRelays(relaysDraft);
		if (relays.length === 0) {
			toast.error('Add at least one relay');
			return;
		}
		setMultiDeviceRelays(relays);
		setMultiDeviceBlossomServers(blossomServersInOrder());
		config = getMultiDeviceConfig();
		if (config) connectionString = buildConnectionString(config);
		toast.success('Advanced settings saved');
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
			// Refresh config so the status card + Add tab reflect the just-linked state
			// without a page reload (the $effect only re-runs on account change).
			config = getMultiDeviceConfig();
			connectionString = config ? buildConnectionString(config) : '';
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
				<!-- Status: reports state only. Enablement is a consequence of an action,
				     not a prerequisite, so there is no master switch. -->
				<Card.Root>
					<Card.Content class="pt-6">
						<div class="flex items-center justify-between gap-4">
							<div class="min-w-0">
								<p class="flex items-center gap-2 text-sm font-medium">
									<span
										class="size-2 shrink-0 rounded-full {enabled
											? 'bg-emerald-500'
											: hasConfig
												? 'bg-red-500'
												: 'bg-muted-foreground'}"
									></span>
									{statusLabel}
								</p>
								<p class="text-xs text-muted-foreground">
									{#if hasConfig && config}
										{config.relays.length} relay{config.relays.length === 1 ? '' : 's'} ·
										{config.blossomServers.length} Blossom host{config.blossomServers.length === 1
											? ''
											: 's'}
									{:else}
										Pick a tab below to share from or link this device.
									{/if}
								</p>
							</div>
							{#if enabled}
								<Button variant="ghost" size="sm" onclick={handlePause}>Pause sync</Button>
							{:else if hasConfig}
								<Button variant="ghost" size="sm" onclick={handleSetup}>Resume sync</Button>
							{/if}
						</div>
					</Card.Content>
				</Card.Root>

				{#if mdProgress.phase}
					<div class="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
						<div class="flex items-center gap-2 text-sm">
							<Spinner class="size-4" />
							<span class="font-medium">
								{mdProgress.phase}{#if mdProgress.total}
									<span class="text-muted-foreground">
										({mdProgress.current}/{mdProgress.total})</span
									>
								{/if}
							</span>
						</div>
						{#if mdProgress.total}
							<div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
								<div
									class="h-full rounded-full bg-foreground transition-all duration-200"
									style="width: {Math.min(100, (mdProgress.current / mdProgress.total) * 100)}%"
								></div>
							</div>
						{/if}
					</div>
				{/if}

				<!-- Tab navigation: always visible. Enablement happens on action completion. -->
				<div class="flex space-x-1 rounded-lg bg-muted p-1">
					<button
						class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab === 'add'
							? 'bg-background shadow-sm'
							: 'hover:bg-muted-foreground/10'}"
						onclick={() => (tab = 'add')}
					>
						Add a device
					</button>
					<button
						class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab === 'link'
							? 'bg-background shadow-sm'
							: 'hover:bg-muted-foreground/10'}"
						onclick={() => (tab = 'link')}
					>
						Link this device
					</button>
				</div>

				{#if tab === 'add'}
					<!-- "Share FROM here": this device is (or becomes) the source. -->
					{#if enabled}
						<Card.Root>
							<Card.Header>
								<Card.Title>Your connection code</Card.Title>
								<Card.Description>
									Scan this on another device logged in as the same identity. It carries no private
									keys — only a locator and a write capability for the tip.
								</Card.Description>
							</Card.Header>
							<Card.Content class="space-y-4">
								<ol class="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
									<li>Open Cordn on your other device, logged in as the same identity.</li>
									<li>
										Go to <span class="font-medium text-foreground">Settings → Multi-device</span>.
									</li>
									<li>
										Under <span class="font-medium text-foreground">Link this device</span>, scan
										this code.
									</li>
								</ol>

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

								{#if !hasLocalGroups}
									<p class="text-xs text-muted-foreground">
										Already set up on another device? Use
										<button class="underline hover:text-foreground" onclick={() => (tab = 'link')}>
											Link this device
										</button>
										instead — enabling here would mint a separate sync identity.
									</p>
								{/if}
							</Card.Content>
						</Card.Root>
					{:else}
						<!-- No config yet, or paused. Configure (defaults pre-filled) then turn on. -->
						<Card.Root>
							<Card.Header>
								<Card.Title>{hasConfig ? 'Resume sharing' : 'Share from this device'}</Card.Title>
								<Card.Description>
									Turn on sync to seal your groups' MLS state and generate a connection code other
									devices can adopt.
								</Card.Description>
							</Card.Header>
							<Card.Content class="space-y-4">
								<ol class="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
									<li>Turn on sync here (sensible defaults are pre-filled under Advanced).</li>
									<li>Open Cordn on your other device, logged in as the same identity.</li>
									<li>
										Under <span class="font-medium text-foreground">Link this device</span>, scan
										the code.
									</li>
								</ol>

								<Button onclick={handleSetup} class="w-full">
									{hasConfig ? 'Resume sync' : 'Turn on sync & generate code'}
								</Button>

								{#if !hasConfig}
									<p class="text-xs text-muted-foreground">
										Already set up on another device? Use
										<button class="underline hover:text-foreground" onclick={() => (tab = 'link')}>
											Link this device
										</button>
										instead.
									</p>
								{/if}
							</Card.Content>
						</Card.Root>
					{/if}

					<!-- Advanced: relays + Blossom redundancy + (when enabled) rotate.
						 Pre-filled with sensible defaults so most users never open it. -->
					<Collapsible.Root bind:open={advancedOpen}>
						<Collapsible.Trigger
							class="flex w-full items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
						>
							Advanced
							<ChevronDown
								class={`size-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
							/>
						</Collapsible.Trigger>
						<Collapsible.Content>
							<div class="mt-3 space-y-4">
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
								</div>

								<div class="space-y-2">
									<Label>Document hosts (pick at least two for redundancy)</Label>
									<div class="grid gap-2">
										{#each BLOSSOM_SERVERS as server (server)}
											<label
												class="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2 text-sm hover:bg-muted/30"
											>
												<input
													type="checkbox"
													class="size-4"
													checked={blossomChecked.has(server)}
													onchange={(e) => toggleBlossom(server, e.currentTarget.checked)}
												/>
												<span class="font-mono text-xs">{server}</span>
												{#if server === DEFAULT_BLOSSOM_SERVER}
													<span class="ml-auto text-xs text-muted-foreground">default</span>
												{/if}
											</label>
										{/each}
									</div>
									<p class="text-xs text-muted-foreground">
										The sealed document is uploaded to all selected hosts; linked devices try them
										in order. More hosts = more resilience.
									</p>
								</div>

								{#if enabled}
									<Button variant="outline" onclick={handleSaveAdvanced} class="w-full">
										Save advanced settings
									</Button>

									<Button
										variant="outline"
										onclick={handleResync}
										disabled={resyncing}
										class="w-full"
									>
										{#if resyncing}
											<Spinner class="mr-2 size-4" />
											Re-syncing…
										{:else}
											<Download class="mr-2 size-4" />
											Re-sync from document
										{/if}
									</Button>
									<p class="mt-1 text-xs text-muted-foreground">
										Fetch the latest group document and catch this device up. Use it if a group
										looks stuck or out of sync.
									</p>

									<div class="border-t border-border pt-4">
										<Button
											variant="outline"
											onclick={handleRotate}
											disabled={rotating}
											class="w-full"
										>
											{#if rotating}
												<Spinner class="mr-2 size-4" />
												Rotating…
											{:else}
												<RefreshCw class="mr-2 size-4" />
												Rotate connection string
											{/if}
										</Button>
										<p class="mt-1 text-xs text-muted-foreground">
											Use rotation if this string leaked. Every previously-linked device must be
											re-linked.
										</p>
									</div>
								{/if}

								{#if config}
									<div class="space-y-3 border-t border-border pt-4">
										<div class="flex items-center gap-2">
											<Switch bind:checked={devMode} id="md-dev-mode" />
											<Label for="md-dev-mode">Dev mode</Label>
											<span class="text-xs text-muted-foreground">
												visibility into the tip, transition history, and relay/blob health
											</span>
										</div>
										{#if devMode}
											<MultiDeviceDevPanel {config} />
										{/if}
									</div>
								{/if}
							</div>
						</Collapsible.Content>
					</Collapsible.Root>
				{:else}
					<!-- "Receive ONTO here": this device adopts an existing source's state.
						 Linking enables sync itself — no prior switch to flip. -->
					<Card.Root>
						<Card.Header>
							<Card.Title>Link this device</Card.Title>
							<Card.Description>
								Paste the connection string from another device, or scan its QR code. This adopts
								that device's groups here.
							</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-4">
							<ol class="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
								<li>
									On your other device, open
									<span class="font-medium text-foreground">Multi-device → Add a device</span>.
								</li>
								<li>Copy the connection string (or show its QR code).</li>
								<li>Paste it here, or scan the code below.</li>
							</ol>

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

				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2">
							<ShieldAlert class="size-4" />
							Security notes
						</Card.Title>
					</Card.Header>
					<Card.Content class="space-y-2 text-xs text-muted-foreground">
						<p>
							Group state is sealed to a per-identity document key (DEK) that itself travels inside
							a NIP-44 seal to your npub — so only a device that can sign as you can obtain the DEK
							and decrypt your groups, yet decryption stays local (no signer round-trip per group).
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
