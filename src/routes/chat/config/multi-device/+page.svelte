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
	import MultiDeviceHealth from '$lib/components/chat/MultiDeviceHealth.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { copyText } from '$lib/services/nativeShims';
	import { page } from '$app/state';
	import { BLOSSOM_SERVERS } from '$lib/constants/chat';
	import {
		enableMultiDevice,
		unlinkMultiDevice,
		rotateMultiDeviceKey,
		setMultiDeviceRelays,
		getMultiDeviceConfig,
		setMultiDeviceBlossomServers,
		DEFAULT_BLOSSOM_SERVERS,
		DEFAULT_MULTI_DEVICE_RELAYS,
		buildConnectionString,
		linkDeviceFromConnectionString,
		reconcileMultiDeviceNow,
		retryMultiDevicePublish,
		mdProgress,
		mdConfigRevision,
		type MultiDeviceOwnerConfig,
		type LinkResult
	} from '$lib/services/multiDevice.svelte';
	import { toast } from 'svelte-sonner';
	import { SvelteSet } from 'svelte/reactivity';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import LinkIcon from '@lucide/svelte/icons/link';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Copy from '@lucide/svelte/icons/copy';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ScanLine from '@lucide/svelte/icons/scan-line';
	import Unlink from '@lucide/svelte/icons/unlink';
	import X from '@lucide/svelte/icons/x';

	let tab = $state<'add' | 'link'>(page.url.searchParams.get('tab') === 'link' ? 'link' : 'add');

	// Live config; re-read on every reactive tick so enable/disable/rotate reflect.
	let config = $state<MultiDeviceOwnerConfig | undefined>(undefined);
	let connectionString = $state('');
	let relaysDraft = $state('');
	// The fleet's own defaults first, then the media presets: a host the sync
	// defaults use must render as a preset, not as a custom entry.
	const BLOSSOM_PRESETS = [
		...DEFAULT_BLOSSOM_SERVERS,
		...BLOSSOM_SERVERS.filter((s) => !DEFAULT_BLOSSOM_SERVERS.includes(s))
	];
	// Blossom redundancy: a checked subset of presets, ordered by BLOSSOM_PRESETS,
	// plus explicit custom hosts (kept in add order). The first entry is the
	// primary (read path tries them in order). SvelteSet is self-reactive, so no
	// $state wrap — mutate in place.
	let blossomChecked = new SvelteSet<string>();
	// Custom hosts outside the preset list; draft-state until Advanced is saved
	// (same as the preset checkboxes — saving persists the union).
	let blossomCustoms = $state<string[]>([]);
	let blossomCustomDraft = $state('');
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

	// Project the persisted config. `mdConfigRevision` is what makes a background
	// publish/reconcile — which writes lastSeenTip behind this page's back — show
	// up as "Sync active" without a reload.
	$effect(() => {
		void mdConfigRevision.value;
		// Track the active account so config reloads on identity switch.
		// IMPORTANT: read localStorage into a local const and only THEN assign to
		// $state — an $effect that reads and writes the same $state loops forever.
		void $activeAccount?.pubkey;
		const cfg = getMultiDeviceConfig();
		config = cfg;
		connectionString = cfg ? buildConnectionString(cfg) : '';
	});

	// Seed the Advanced editors from the persisted relay/host lists only. Keyed
	// by value: a save that only touched lastSeenTip or the activity log must not
	// wipe a relay edit in progress.
	let draftsKey = '';
	$effect(() => {
		void mdConfigRevision.value;
		const pubkey = $activeAccount?.pubkey;
		const cfg = getMultiDeviceConfig();
		const relays = cfg?.relays ?? DEFAULT_MULTI_DEVICE_RELAYS;
		const servers = cfg ? cfg.blossomServers : DEFAULT_BLOSSOM_SERVERS;
		const key = `${pubkey}|${relays.join(',')}|${servers.join(',')}`;
		if (key === draftsKey) return;
		draftsKey = key;
		relaysDraft = relays.join('\n');
		blossomChecked.clear();
		// Accumulate customs in a plain array and assign ONCE: pushing into the
		// $state array below would read+write it inside this effect and loop
		// forever (effect_update_depth_exceeded, which kills the page's reactivity).
		const customs: string[] = [];
		for (const s of servers) {
			// A stored host outside the preset list is a custom entry — keeping it
			// here stops a save from silently dropping it (the presets-only filter
			// used to do exactly that).
			if (BLOSSOM_PRESETS.includes(s)) blossomChecked.add(s);
			else customs.push(s);
		}
		blossomCustoms = customs;
	});

	const hasConfig = $derived(!!config);
	// Unpublished work persists here until its tip write lands, so it is the
	// honest signal for "changes not synced yet" — including a first publish that
	// failed and is waiting on the retry ladder.
	const pendingPublish = $derived(config?.pendingPublish);

	// Every linked device both reads and writes (mesh of equal peers, spec §11),
	// so there is no enabled/disabled distinction — but "Sync active" is only
	// honest once a tip has been read or published AND nothing is waiting to go
	// out. A config that has never seen a tip is linked-but-not-converged (slow
	// relays, or a signer that cannot decrypt the tip at all).
	const statusLabel = $derived(
		!hasConfig
			? 'Not set up yet'
			: pendingPublish
				? config?.lastSeenTip
					? 'Publishing changes…'
					: 'Preparing first sync…'
				: config?.lastSeenTip
					? 'Sync active'
					: 'Linked — not synced yet'
	);
	const statusGreen = $derived(hasConfig && !pendingPublish && !!config?.lastSeenTip);

	// Ticker so the tip age on the status card stays honest without a reload.
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
	const tipAgeLabel = $derived.by(() => {
		const at = config?.lastSeenTipCreatedAt;
		if (!at || !config?.lastSeenTip) return '';
		const ms = now - at * 1000;
		if (ms < 60_000) return 'just now';
		const minutes = Math.floor(ms / 60_000);
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} h ago`;
		return new Date(at * 1000).toLocaleString();
	});

	function toggleBlossom(server: string, checked: boolean) {
		if (checked) {
			blossomChecked.add(server);
		} else if (blossomChecked.size + blossomCustoms.length > 1) {
			// Keep at least one host so the document is always reachable.
			blossomChecked.delete(server);
		} else {
			toast.error('Keep at least one Blossom server for redundancy');
		}
	}

	function blossomServersInOrder(): string[] {
		// Primary = first preset (in declared order) that is checked; customs
		// follow in add order. Preserves a stable priority without asking the
		// user to order the list manually.
		return [...BLOSSOM_PRESETS.filter((s) => blossomChecked.has(s)), ...blossomCustoms];
	}

	function addBlossomCustom() {
		const raw = blossomCustomDraft.trim();
		try {
			const url = new URL(raw);
			if (url.protocol !== 'https:') throw new Error('not https');
			// Document fetches address `${server}<sha256>`, so hosts are origins.
			const server = `${url.origin}/`;
			if (BLOSSOM_PRESETS.includes(server) || blossomCustoms.includes(server)) {
				toast.error('That host is already in the list');
				return;
			}
			blossomCustoms = [...blossomCustoms, server];
			blossomCustomDraft = '';
		} catch {
			toast.error('Enter an https:// Blossom server URL');
		}
	}

	function removeBlossomCustom(server: string) {
		if (blossomServersInOrder().length <= 1) {
			toast.error('Keep at least one Blossom server for redundancy');
			return;
		}
		blossomCustoms = blossomCustoms.filter((s) => s !== server);
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
			toast.success('Multi-device sync enabled');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not enable multi-device');
		}
	}

	function handleUnlink() {
		// The shared groups are the real cost: they stop working here the first time
		// another device changes one (this device can no longer follow the tip).
		const shared = config?.lastSeenTip?.groups.length ?? 0;
		const body = shared
			? `Unlink this device? The ${shared} group${shared === 1 ? '' : 's'} it shares with your other devices stay here, but stop working the first time one of them changes, and getting ${shared === 1 ? 'it' : 'one'} back needs the group to let this device in again. Your other devices are unaffected.`
			: 'Unlink this device? It will stop syncing. Your groups stay on this device as last synced. Your other devices are unaffected. Re-link anytime with a connection string.';
		if (!confirm(body)) return;
		unlinkMultiDevice();
		config = getMultiDeviceConfig();
		connectionString = '';
		toast.success('Device unlinked — re-link anytime with a connection string');
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
			// "Sync now" must also push what has not gone out: reading the tip alone
			// cannot heal a failed or stranded publish (it just reports "no tip").
			const retried = retryMultiDevicePublish();
			const result = await reconcileMultiDeviceNow();
			if (result.status === 'ok') {
				const { counts } = result;
				toast.success(
					`Synced — ${counts.fastForwarded} caught up, ${counts.seeded} new, ${counts.skipped} already current`
				);
			} else if (result.status === 'signer-no-nip44') {
				toast.error('This signer does not support NIP-44 v2 — multi-device sync needs it');
			} else if (result.status === 'no-tip' && retried) {
				toast.info("No tip yet — publishing this device's groups now");
			} else if (result.status === 'no-tip') {
				toast.error('No tip found on the configured relays — check them or link again');
			} else if (result.status === 'unreadable-tip') {
				toast.error('Found a tip but could not decrypt or verify it');
			} else {
				toast.error('Multi-device sync is off on this device');
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
			await copyText(connectionString);
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
		if (
			config &&
			!confirm(
				"Replace this device's current sync setup with the one from this connection string? Chats already here are kept, but this device will stop following its current sync tip."
			)
		)
			return;
		linking = true;
		linkResult = null;
		try {
			linkResult = await linkDeviceFromConnectionString(linkInput.trim());
			linkInput = '';
			if (!linkResult.foundTip) {
				// Linked is not the same as synced: no tip may mean the peer is still
				// preparing one, or that its relays are slow. Keep the outcome visible.
				toast.warning('Linked — no groups arrived yet; sync will keep trying');
			} else if (
				linkResult.seeded === 0 &&
				linkResult.fastForwarded === 0 &&
				linkResult.skipped === 0
			) {
				toast.success('Linked — this device was already up to date');
			} else if (linkResult.seeded === 0 && linkResult.fastForwarded === 0) {
				toast.success('Linked — newer groups on this device will be published');
			} else {
				toast.success(`Linked — ${linkResult.seeded} added, ${linkResult.fastForwarded} updated`);
			}
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
		<div class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card">
			<Smartphone class="size-4" />
		</div>
		<div class="min-w-0">
			<h1 class="text-lg font-semibold tracking-tight">Multi-device sync</h1>
			<p class="truncate text-sm text-muted-foreground">
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
										class="size-2 shrink-0 rounded-full {!hasConfig
											? 'bg-muted-foreground'
											: statusGreen
												? 'bg-emerald-500'
												: 'bg-amber-500'}"
									></span>
									{statusLabel}
								</p>
								<p class="text-xs text-muted-foreground">
									{#if hasConfig && config}
										{#if config.lastSeenTip}
											{config.lastSeenTip.groups.length} group{config.lastSeenTip.groups.length ===
											1
												? ''
												: 's'} shared ·
										{/if}
										{config.relays.length} relay{config.relays.length === 1 ? '' : 's'} ·
										{config.blossomServers.length} Blossom host{config.blossomServers.length === 1
											? ''
											: 's'}
										{#if tipAgeLabel}· tip {tipAgeLabel}{/if}
									{:else}
										Pick a tab below to share from or link this device.
									{/if}
								</p>
							</div>
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

				{#if hasConfig}
					<!-- Configured: two primary actions, no permanent tabs. Re-linking is a
					     recovery path and lives under Advanced. -->
					<div class="flex gap-2">
						<Button class="flex-1" onclick={() => (tab = 'add')}>
							<Smartphone class="mr-2 size-4" />
							Add a device
						</Button>
						<Button variant="outline" class="flex-1" onclick={handleResync} disabled={resyncing}>
							{#if resyncing}
								<Spinner class="mr-2 size-4" />
								Syncing…
							{:else}
								<RefreshCw class="mr-2 size-4" />
								Sync now
							{/if}
						</Button>
					</div>
				{:else}
					<!-- Not set up yet: the two ways in. Enablement happens on action completion. -->
					<div class="flex space-x-1 rounded-lg bg-muted p-1">
						<button
							class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab ===
							'add'
								? 'bg-background shadow-sm'
								: 'hover:bg-muted-foreground/10'}"
							onclick={() => (tab = 'add')}
						>
							This is my first device
						</button>
						<button
							class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab ===
							'link'
								? 'bg-background shadow-sm'
								: 'hover:bg-muted-foreground/10'}"
							onclick={() => (tab = 'link')}
						>
							I sync on another device
						</button>
					</div>
				{/if}

				{#if tab === 'add'}
					<!-- "Share FROM here": this device is (or becomes) the source. -->
					{#if hasConfig}
						<Card.Root>
							<Card.Header>
								<Card.Title>Your connection code</Card.Title>
								<Card.Description>
									Scan this on another device logged in as the same identity. It does not contain
									your account key, but it does grant write access to the sync tip — treat it like a
									password and share it only with your own devices.
								</Card.Description>
							</Card.Header>
							<Card.Content class="space-y-4">
								{#if config?.lastSeenTip}
									<ol class="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
										<li>Open Cordn on your other device, logged in as the same identity.</li>
										<li>
											Go to <span class="font-medium text-foreground">Settings → Multi-device</span
											>.
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
								{:else}
									<!-- The string is only usable once a tip exists; showing it early invites a
									     scan that would find nothing. -->
									<div class="space-y-2 rounded-lg border border-dashed border-border p-4">
										<p class="flex items-center gap-2 text-sm font-medium">
											{#if mdProgress.phase}<Spinner class="size-4" />{/if}
											{mdProgress.phase
												? 'Preparing your connection code…'
												: 'Connection code not ready yet'}
										</p>
										<p class="text-xs text-muted-foreground">
											{mdProgress.phase
												? 'The first sync is in progress.'
												: 'No sync tip is available yet; sync will retry automatically.'} The code appears
											here as soon as one arrives.
										</p>
									</div>
								{/if}
							</Card.Content>
						</Card.Root>
					{:else}
						<!-- No config yet. Configure (defaults pre-filled) then turn on. -->
						<Card.Root>
							<Card.Header>
								<Card.Title>Share from this device</Card.Title>
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

								<Button onclick={handleSetup} class="w-full"
									>Turn on sync &amp; generate code</Button
								>

								<p class="text-xs text-muted-foreground">
									Already set up on another device? Use
									<button class="underline hover:text-foreground" onclick={() => (tab = 'link')}>
										Link this device
									</button>
									instead.
								</p>
							</Card.Content>
						</Card.Root>
					{/if}

					<!-- Advanced: relays + Blossom redundancy + (when configured) rotate.
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
									<Label>Document hosts</Label>
									<div class="grid gap-2">
										{#each BLOSSOM_PRESETS as server (server)}
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
												{#if server === DEFAULT_BLOSSOM_SERVERS[0]}
													<span class="ml-auto text-xs text-muted-foreground">default</span>
												{/if}
											</label>
										{/each}
										{#each blossomCustoms as server (server)}
											<div
												class="flex items-center gap-2 rounded-md border border-dashed border-border p-2 text-sm"
											>
												<span class="font-mono text-xs">{server}</span>
												<span class="text-xs text-muted-foreground">custom</span>
												<button
													type="button"
													class="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
													aria-label={`Remove ${server}`}
													onclick={() => removeBlossomCustom(server)}
												>
													<X class="size-3.5" />
												</button>
											</div>
										{/each}
										<div class="flex gap-2">
											<Input
												placeholder="https://your-blossom-server.com"
												bind:value={blossomCustomDraft}
												class="font-mono text-xs"
												onkeydown={(e) => e.key === 'Enter' && addBlossomCustom()}
											/>
											<Button variant="outline" onclick={addBlossomCustom}>Add</Button>
										</div>
									</div>
									<p class="text-xs text-muted-foreground">
										Every change is uploaded to all selected hosts; linked devices try them in
										order. One host is enough to sync, two or more is safer. Each extra host adds an
										upload per change.
									</p>
								</div>

								{#if config}
									<Button variant="outline" onclick={handleSaveAdvanced} class="w-full">
										Save advanced settings
									</Button>

									<div class="border-t border-border pt-4">
										<MultiDeviceHealth {config} />
									</div>

									<div class="border-t border-border pt-4">
										<Button variant="outline" onclick={() => (tab = 'link')} class="w-full">
											<LinkIcon class="mr-2 size-4" />
											Link this device instead
										</Button>
										<p class="mt-1 text-xs text-muted-foreground">
											Adopt the state of another device. This replaces this device's sync setup and
											its connection string; chats already here are kept.
										</p>
									</div>

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

									<div class="border-t border-border pt-4">
										<Button variant="outline" onclick={handleUnlink} class="w-full">
											<Unlink class="mr-2 size-4" />
											Unlink this device
										</Button>
										<p class="mt-1 text-xs text-muted-foreground">
											Stop syncing on this device. Your groups stay as last synced; re-link anytime
											with a connection string. Other devices keep syncing.
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
								Scan another device's QR code or paste its connection string. This adopts that
								device's groups here.
							</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-4">
							{#if hasConfig}
								<!-- Deep links (?tab=link) and Advanced land here on a device that already
								     syncs; the configured layout has no tab bar, so offer a way back. -->
								<Button variant="outline" size="sm" onclick={() => (tab = 'add')} class="w-full">
									This device is already set up — go back
								</Button>
							{/if}

							<!-- Scan first: this page is the mobile path. -->
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
								<Button onclick={() => (scanning = true)} class="w-full">
									<ScanLine class="mr-2 size-4" />
									Scan QR code
								</Button>
							{/if}

							<div class="flex items-center gap-2 text-xs text-muted-foreground">
								<div class="h-px flex-1 bg-border"></div>
								<span>or paste the string</span>
								<div class="h-px flex-1 bg-border"></div>
							</div>

							<div class="space-y-2">
								<Label for="md-link-input">Connection string</Label>
								<Input
									id="md-link-input"
									bind:value={linkInput}
									placeholder="Paste the connection string here"
									class="font-mono text-xs"
								/>
							</div>

							<Button onclick={handleLink} disabled={linking || !linkInput.trim()} class="w-full">
								{#if linking}
									<Spinner class="mr-2 size-4" />
									Linking…
								{:else}
									<LinkIcon class="mr-2 size-4" />
									Link device
								{/if}
							</Button>

							{#if linkResult}
								<div class="rounded-lg border border-border bg-muted/30 p-3 text-sm">
									{#if linkResult.foundTip}
										<p class="font-medium">Linked</p>
										<p class="text-muted-foreground">
											{linkResult.seeded} group{linkResult.seeded === 1 ? '' : 's'} added,
											{linkResult.fastForwarded} updated. New groups sync as they're added.
										</p>
									{:else}
										<p class="font-medium">Linked — waiting for the first sync</p>
										<p class="text-muted-foreground">
											No sync tip arrived yet. The other device may still be preparing it, or the
											relays may be slow. Groups appear here as soon as one arrives.
										</p>
									{/if}
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
							Your groups are encrypted with a key that only your identity can unwrap. It is
							delivered sealed to your npub, and decryption happens on the device — the signer is
							never asked once per group.
						</p>
						<p>
							The sync pointer uses a throwaway key instead of your identity key, so the pointer
							itself does not identify your account.
						</p>
						<p>
							A leaked connection string lets someone point your devices at an old copy (denial of
							service). It cannot forge a valid pointer or decrypt anything.
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
