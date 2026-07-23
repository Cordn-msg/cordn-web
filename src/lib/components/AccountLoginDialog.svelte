<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { manager } from '$lib/services/accountManager.svelte';
	import {
		getInstalledSignerApps,
		connectAndroidSigner,
		isAndroidNative,
		type InstalledSignerApp
	} from '$lib/services/nativeBridge';
	import { ExtensionSigner, NostrConnectSigner } from 'applesauce-signers/signers';
	import {
		ExtensionAccount,
		NostrConnectAccount,
		PrivateKeyAccount
	} from 'applesauce-accounts/accounts';
	import QrCode from '$lib/components/QrCode.svelte';
	import { generateSecretKey } from 'nostr-tools';
	import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
	import { nsecEncode } from 'nostr-tools/nip19';
	import { Metadata } from 'nostr-tools/kinds';
	import { DIALOG_IDS, dialogState } from '$lib/stores/dialog-state.svelte';
	import { relayPool, metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '$lib/services/eventStore';
	import { copyToClipboard } from '$lib/utils';
	import { publicWebOrigin } from '$lib/utils/appOrigin';
	import { toast } from 'svelte-sonner';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Copy from '@lucide/svelte/icons/copy';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Gem from '@lucide/svelte/icons/gem';

	let open = $state(false);

	$effect(() => {
		if (dialogState.dialogId === DIALOG_IDS.LOGIN) {
			open = true;
		}
	});

	let selectedTab = $state<'extension' | 'simple' | 'remote' | 'signer'>('extension');
	let privateKey = $state('');
	let bunkerUri = $state('');
	let nostrConnectUri = $state('');
	let loading = $state(false);
	let error = $state('');
	let remoteSignerStep = $state<'generate' | 'connecting' | 'manual'>('generate');
	let showPrivateKey = $state(false);
	let displayName = $state('');
	let androidSignerApps = $state<InstalledSignerApp[] | null>(null);
	let connectingPkg = $state<string | null>(null);
	let androidSignerError = $state('');
	let username = $state('');
	let about = $state('');
	let profileExpanded = $state(false);
	let pasteExpanded = $state(false);

	async function connectExtension() {
		try {
			loading = true;
			error = '';

			const signer = new ExtensionSigner();
			const pubkey = await signer.getPublicKey();
			const account = new ExtensionAccount(pubkey, signer);

			manager.addAccount(account);
			manager.setActive(account);

			open = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to connect extension';
		} finally {
			loading = false;
		}
	}

	function resetSimpleState() {
		privateKey = '';
		showPrivateKey = false;
		displayName = '';
		username = '';
		about = '';
		profileExpanded = false;
		pasteExpanded = false;
	}

	async function connectSimple() {
		if (!privateKey.trim()) {
			error = 'Please enter a private key';
			return;
		}

		try {
			loading = true;
			error = '';

			const signer = PrivateKeyAccount.fromKey(privateKey.trim());
			const account = new PrivateKeyAccount(signer.pubkey, signer.signer);

			manager.addAccount(account);
			manager.setActive(account);

			const name = username.trim();
			const displayNameTrimmed = displayName.trim();
			const aboutTrimmed = about.trim();

			if (name || displayNameTrimmed || aboutTrimmed) {
				try {
					const content = JSON.stringify({
						name: name || undefined,
						display_name: displayNameTrimmed || undefined,
						about: aboutTrimmed || undefined
					});

					const unsignedEvent = {
						kind: Metadata,
						created_at: Math.floor(Date.now() / 1000),
						tags: [],
						content,
						pubkey: account.pubkey
					};

					const accountSigner = (
						account as unknown as {
							signer?: {
								signEvent?: (
									event: typeof unsignedEvent
								) => Promise<typeof unsignedEvent & { id: string; sig: string }>;
							};
						}
					).signer;

					if (accountSigner?.signEvent) {
						const nextEvent = await accountSigner.signEvent(unsignedEvent);

						for (const relay of metadataRelays) {
							await relayPool.relay(relay).publish(nextEvent);
						}

						eventStore.add(nextEvent);
					}
				} catch {
					// Profile publishing is best-effort; don't block login on metadata failure.
				}
			}

			toast.success('Account created');
			open = false;
			resetSimpleState();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to connect with private key';
		} finally {
			loading = false;
		}
	}

	function generatePrivateKey() {
		const secretKey = generateSecretKey();
		privateKey = bytesToHex(secretKey);
		showPrivateKey = false;
	}

	function toNsec(key: string): string {
		if (!key || key.startsWith('nsec')) return key;
		try {
			return nsecEncode(hexToBytes(key));
		} catch {
			return key;
		}
	}

	async function copyPrivateKey() {
		if (!privateKey) return;
		await copyToClipboard(toNsec(privateKey));
	}

	async function generateRemoteSignerUri(openApp = false) {
		try {
			loading = true;
			error = '';

			const signer = new NostrConnectSigner({
				relays: ['wss://relay.primal.net', 'wss://relay.nostr.net', 'wss://relay.damus.io']
			});

			// Generate nostr connect URI with app metadata and permissions
			const uri = signer.getNostrConnectURI({
				name: 'Cordn-web',
				url: publicWebOrigin(),
				image: `${publicWebOrigin()}/favicon.svg`
			});

			nostrConnectUri = uri;

			// Open the URI to launch a remote signer app (e.g. Amber)
			if (openApp) window.location.href = uri;

			remoteSignerStep = 'connecting';

			// Start waiting for the signer to connect
			await signer.waitForSigner();

			// Get the user's public key
			const pubkey = await signer.getPublicKey();
			const account = new NostrConnectAccount(pubkey, signer);

			manager.addAccount(account);
			manager.setActive(account);

			// Reset state and close dialog
			resetRemoteSignerState();
			open = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to connect remote signer';
			remoteSignerStep = 'generate';
		} finally {
			loading = false;
		}
	}

	async function connectWithBunkerUri() {
		if (!bunkerUri.trim()) {
			error = 'Please enter a bunker URI';
			return;
		}

		try {
			loading = true;
			error = '';

			const signer = await NostrConnectSigner.fromBunkerURI(bunkerUri.trim());

			// Connect to the remote signer
			await signer.connect();

			// Get the user's public key
			const pubkey = await signer.getPublicKey();
			const account = new NostrConnectAccount(pubkey, signer);

			manager.addAccount(account);
			manager.setActive(account);

			// Reset state and close dialog
			resetRemoteSignerState();
			bunkerUri = '';
			open = false;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to connect with bunker URI';
		} finally {
			loading = false;
		}
	}

	function resetRemoteSignerState() {
		loading = false;
		remoteSignerStep = 'generate';
		nostrConnectUri = '';
		error = '';
	}

	function handleSubmit() {
		if (selectedTab === 'extension') {
			connectExtension();
		} else if (selectedTab === 'simple') {
			connectSimple();
		} else if (selectedTab === 'remote') {
			if (remoteSignerStep === 'manual') {
				connectWithBunkerUri();
			} else {
				generateRemoteSignerUri();
			}
		}
	}

	// Reset remote signer state when tab changes
	$effect(() => {
		if (selectedTab !== 'remote') {
			resetRemoteSignerState();
		}
	});

	$effect(() => {
		if (selectedTab !== 'simple') {
			showPrivateKey = false;
		}
	});

	// Auto-select the best login method when the dialog opens: installed signer app (Android,
	// recommended) → browser extension → sign up. Re-evaluates if signer apps resolve after open
	// (rare); it won't yank a manual choice because the deps (open, androidSignerApps) don't
	// change once the user starts clicking tabs.
	$effect(() => {
		if (!open) return;
		if (isAndroidNative() && androidSignerApps && androidSignerApps.length > 0) {
			selectedTab = 'signer';
		} else if (typeof window !== 'undefined' && 'nostr' in window) {
			selectedTab = 'extension';
		} else {
			selectedTab = 'simple';
		}
	});

	// Probe once for installed Android signer apps (Amber, etc.) via NIP-55 on mount of the native
	// shell, so the result is resolved before the dialog opens — avoids a tab flash when the
	// recommended signer tab becomes the default. Web/iOS never probe (-> null, tab hidden).
	// Best-effort: a missing plugin or zero installed signers resolves to [] and the tab is hidden.
	$effect(() => {
		if (!isAndroidNative()) return;
		let cancelled = false;
		getInstalledSignerApps().then((apps) => {
			if (!cancelled) androidSignerApps = apps;
		});
		return () => {
			cancelled = true;
		};
	});

	async function handleAndroidSignerLogin(app: InstalledSignerApp) {
		connectingPkg = app.packageName;
		androidSignerError = '';
		try {
			await connectAndroidSigner(app);
			open = false;
		} catch (err) {
			androidSignerError = err instanceof Error ? err.message : 'Failed to connect signer app';
		} finally {
			connectingPkg = null;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={() => (dialogState.dialogId = null)}>
	<Dialog.Trigger class={buttonVariants({ variant: 'outline' })}>Login</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>Connect Account</Dialog.Title>
			<Dialog.Description>Choose how you want to connect to Nostr</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4 py-4">
			<!-- Tab Navigation -->
			<div class="flex space-x-1 rounded-lg bg-muted p-1">
				{#if isAndroidNative() && androidSignerApps && androidSignerApps.length > 0}
					<button
						class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {selectedTab ===
						'signer'
							? 'bg-background shadow-sm'
							: 'hover:bg-muted-foreground/10'}"
						onclick={() => (selectedTab = 'signer')}
					>
						Signer app
					</button>
				{/if}
				{#if typeof window !== 'undefined' && 'nostr' in window}
					<button
						class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {selectedTab ===
						'extension'
							? 'bg-background shadow-sm'
							: 'hover:bg-muted-foreground/10'}"
						onclick={() => (selectedTab = 'extension')}
					>
						Extension
					</button>
				{/if}
				<button
					class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {selectedTab ===
					'simple'
						? 'bg-background shadow-sm'
						: 'hover:bg-muted-foreground/10'}"
					onclick={() => (selectedTab = 'simple')}
				>
					Sign up
				</button>
				<button
					class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {selectedTab ===
					'remote'
						? 'bg-background shadow-sm'
						: 'hover:bg-muted-foreground/10'}"
					onclick={() => (selectedTab = 'remote')}
				>
					Remote Signer
				</button>
			</div>

			<!-- Signer app Tab (Android NIP-55) -->
			{#if selectedTab === 'signer'}
				<div class="space-y-2">
					<p class="text-sm text-muted-foreground">
						Connect with an installed signer app via NIP-55 — your keys never leave the signer.
					</p>
					{#if androidSignerError}
						<p class="text-sm text-destructive">{androidSignerError}</p>
					{/if}
					{#each androidSignerApps as app (app.packageName)}
						<Button
							class="w-full justify-start"
							disabled={connectingPkg !== null}
							onclick={() => handleAndroidSignerLogin(app)}
						>
							{#if connectingPkg === app.packageName}
								<Spinner class="mr-2 size-4" />
								Connecting…
							{:else}
								<Gem class="mr-2 size-4" />
								Log in with {app.name}
							{/if}
						</Button>
					{/each}
				</div>
			{/if}

			<!-- Extension Tab -->
			{#if selectedTab === 'extension'}
				<div class="space-y-4">
					<p class="text-sm text-muted-foreground">
						Connect using a browser extension like Nos2x or Alby.
					</p>
					{#if typeof window !== 'undefined' && !('nostr' in window)}
						<p class="text-sm text-destructive">
							No Nostr extension detected. Please install a Nostr extension first.
						</p>
					{/if}
				</div>
			{/if}

			<!-- Sign up Tab -->
			{#if selectedTab === 'simple'}
				<div class="space-y-4">
					{#if !privateKey}
						<div class="space-y-3">
							<p class="text-sm text-muted-foreground">
								Create a new Nostr account — all you need to get started.
							</p>
							<Button class="w-full" onclick={generatePrivateKey} type="button">
								Generate a new account
							</Button>
						</div>

						<!-- Already have a private key? collapsible -->
						<div class="space-y-3">
							<button
								type="button"
								onclick={() => (pasteExpanded = !pasteExpanded)}
								class="flex items-center gap-1 text-sm font-medium"
							>
								Already have a private key?
								<ChevronDown
									class="ml-1 size-4 text-muted-foreground transition-transform duration-200 {pasteExpanded
										? 'rotate-180'
										: ''}"
								/>
							</button>
							{#if pasteExpanded}
								<div class="space-y-2">
									<Label for="account-private-key-paste">Private key</Label>
									<Input
										id="account-private-key-paste"
										placeholder="Paste your private key (hex or nsec)"
										bind:value={privateKey}
										class="font-mono"
									/>
									<p class="text-xs text-muted-foreground">
										Your private key will be stored securely in your browser's local storage.
									</p>
								</div>
							{/if}
						</div>
					{:else}
						<div class="space-y-2">
							<Label for="account-private-key">Your private key</Label>
							<div class="flex gap-2">
								<div class="relative flex-1">
									<Input
										id="account-private-key"
										value={showPrivateKey ? toNsec(privateKey) : '••••••••••••••••••••••••••••'}
										readonly
										class="pr-10 font-mono"
										type="text"
									/>
									<button
										type="button"
										onclick={() => (showPrivateKey = !showPrivateKey)}
										class="absolute inset-y-0 right-2 flex items-center text-muted-foreground transition-colors hover:text-foreground"
										aria-label={showPrivateKey ? 'Hide private key' : 'Show private key'}
									>
										{#if showPrivateKey}
											<EyeOff class="size-4" />
										{:else}
											<Eye class="size-4" />
										{/if}
									</button>
								</div>
								<Button
									variant="outline"
									size="icon"
									onclick={copyPrivateKey}
									type="button"
									aria-label="Copy private key"
								>
									<Copy class="size-4" />
								</Button>
							</div>
							<p class="text-xs text-muted-foreground">
								Save this key somewhere safe — it's the only way to access your account.
							</p>
						</div>

						<!-- Profile Details collapsible -->
						<div class="space-y-3">
							<button
								type="button"
								onclick={() => (profileExpanded = !profileExpanded)}
								class="flex items-center gap-1 text-sm font-medium"
							>
								Customize your profile (optional)
								<ChevronDown
									class="ml-1 size-4 text-muted-foreground transition-transform duration-200 {profileExpanded
										? 'rotate-180'
										: ''}"
								/>
							</button>
							{#if profileExpanded}
								<div class="space-y-3">
									<div class="space-y-2">
										<Label for="signup-display-name">Display name</Label>
										<Input
											id="signup-display-name"
											placeholder="How others will see you"
											bind:value={displayName}
										/>
									</div>
									<div class="space-y-2">
										<Label for="signup-username">Username</Label>
										<Input id="signup-username" placeholder="Your username" bind:value={username} />
									</div>
									<div class="space-y-2">
										<Label for="signup-about">About</Label>
										<Textarea
											id="signup-about"
											placeholder="Tell others about yourself"
											bind:value={about}
										/>
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Remote Signer Tab -->
			{#if selectedTab === 'remote'}
				<div class="space-y-4">
					{#if remoteSignerStep === 'generate'}
						<div class="space-y-4">
							<p class="text-sm text-muted-foreground">
								Connect using a remote signer app that supports NIP-46 (Nostr Connect).
							</p>
							<div class="flex flex-col gap-2">
								<Button class="w-full" onclick={() => generateRemoteSignerUri(true)}>
									Open Remote Signer
								</Button>
								<Button
									variant="outline"
									class="w-full"
									onclick={() => (remoteSignerStep = 'manual')}
								>
									Enter Bunker URI
								</Button>
							</div>
						</div>
					{:else if remoteSignerStep === 'connecting'}
						<div class="space-y-4 text-center">
							<p class="text-sm text-muted-foreground">
								Scan this QR code with your signer app or copy the connection string:
							</p>

							{#if nostrConnectUri}
								<div class="flex justify-center">
									<QrCode data={nostrConnectUri} size={300} />
								</div>
							{/if}

							<div class="space-y-2">
								<Label for="connect-uri">Connection String</Label>
								<Input
									id="connect-uri"
									value={nostrConnectUri}
									readonly
									class="font-mono text-xs"
									onclick={(e) => (e.target as HTMLInputElement)?.select()}
								/>
								<p class="text-xs text-muted-foreground">Waiting for signer app to connect...</p>
							</div>

							<Button variant="outline" onclick={() => resetRemoteSignerState()}>Cancel</Button>
						</div>
					{:else if remoteSignerStep === 'manual'}
						<div class="space-y-4">
							<div class="space-y-2">
								<Label for="bunker-uri">Bunker URI</Label>
								<Input
									id="bunker-uri"
									placeholder="bunker://..."
									bind:value={bunkerUri}
									class="font-mono"
								/>
								<p class="text-xs text-muted-foreground">
									Enter the bunker URI provided by your signer app.
								</p>
							</div>
							<Button variant="outline" onclick={() => (remoteSignerStep = 'generate')}>
								Back to QR Code
							</Button>
						</div>
					{/if}
				</div>
			{/if}

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={() => {
					open = false;
					resetSimpleState();
				}}
				disabled={loading}
			>
				Cancel
			</Button>
			{#if (selectedTab === 'remote' && remoteSignerStep === 'connecting') || selectedTab === 'signer'}
				<!-- No submit button: the signer-app tab uses direct per-app CTAs; remote-connecting
				     waits for the signer. -->
			{:else}
				<Button
					onclick={handleSubmit}
					disabled={loading || (selectedTab === 'simple' && !privateKey)}
				>
					{#if loading}
						<Spinner class="mr-2 size-4" />
					{/if}
					{loading
						? 'Connecting...'
						: selectedTab === 'remote' && remoteSignerStep === 'manual'
							? 'Connect with Bunker URI'
							: selectedTab === 'remote'
								? 'Generate QR Code'
								: selectedTab === 'simple' && privateKey
									? 'Sign up'
									: 'Connect'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
