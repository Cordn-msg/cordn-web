<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import SecretKeyReveal from '$lib/components/chat/SecretKeyReveal.svelte';
	import { manager } from '$lib/services/accountManager.svelte';
	import { eventStore } from '$lib/services/eventStore';
	import { metadataRelays, relayPool } from '$lib/services/relay-pool';
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
	import { DIALOG_IDS, dialogState } from '$lib/stores/dialog-state.svelte';
	import { cn } from '$lib/utils';
	import { publicWebOrigin } from '$lib/utils/appOrigin';
	import { toast } from 'svelte-sonner';
	import { Metadata } from 'nostr-tools/kinds';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Gem from '@lucide/svelte/icons/gem';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Puzzle from '@lucide/svelte/icons/puzzle';
	import Shield from '@lucide/svelte/icons/shield';
	import UserPlus from '@lucide/svelte/icons/user-plus';

	let open = $state(false);

	let {
		triggerLabel = 'Login',
		triggerVariant = 'outline',
		triggerClass = '',
		context = '',
		onOpenChange = () => {}
	}: {
		triggerLabel?: string;
		triggerVariant?: 'outline' | 'default' | 'ghost';
		triggerClass?: string;
		/** One line about why the dialog opened (e.g. a pending group invitation). */
		context?: string;
		onOpenChange?: (open: boolean) => void;
	} = $props();

	const triggerClasses = $derived(cn(buttonVariants({ variant: triggerVariant }), triggerClass));

	$effect(() => {
		if (dialogState.dialogId === DIALOG_IDS.LOGIN) {
			open = true;
		}
	});

	type View = 'choose' | 'created' | 'import' | 'remote';

	let view = $state<View>('choose');
	let importKey = $state('');
	let createdAccount = $state<PrivateKeyAccount | null>(null);
	let displayName = $state('');
	let bunkerUri = $state('');
	let nostrConnectUri = $state('');
	let loading = $state(false);
	let error = $state('');
	let remoteSignerStep = $state<'generate' | 'connecting' | 'manual'>('generate');
	let androidSignerApps = $state<InstalledSignerApp[] | null>(null);
	let connectingPkg = $state<string | null>(null);
	let androidSignerError = $state('');

	// The dialog is a sequence of small goal screens, not a tab bar: each view
	// owns its primary action, so "Sign up" and "paste a key" can't be confused.
	$effect(() => {
		if (open) resetDialog();
	});

	function resetDialog() {
		view = 'choose';
		error = '';
		importKey = '';
		createdAccount = null;
		displayName = '';
		bunkerUri = '';
		androidSignerError = '';
		resetRemoteSignerState();
	}

	function closeDialog() {
		open = false;
		resetDialog();
	}

	async function connectExtension() {
		try {
			loading = true;
			error = '';

			const signer = new ExtensionSigner();
			const pubkey = await signer.getPublicKey();
			const account = new ExtensionAccount(pubkey, signer);

			manager.addAccount(account);
			manager.setActive(account);

			closeDialog();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to connect extension';
		} finally {
			loading = false;
		}
	}

	async function signInWithKey(key: string) {
		if (!key.trim()) {
			error = 'Please enter a private key';
			return;
		}

		try {
			loading = true;
			error = '';

			const account = PrivateKeyAccount.fromKey(key.trim());
			manager.addAccount(account);
			manager.setActive(account);
			toast.success('Signed in');
			closeDialog();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to connect with private key';
		} finally {
			loading = false;
		}
	}

	async function createIdentity() {
		if (loading) return;
		try {
			loading = true;
			error = '';

			const account = PrivateKeyAccount.generateNew();
			manager.addAccount(account);
			// Activate on Continue/close, not here: the chat home swaps to the
			// logged-in branch as soon as the account goes active, which would
			// unmount this dialog before the key is shown.
			createdAccount = account;
			view = 'created';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create an identity';
		} finally {
			loading = false;
		}
	}

	// Safety net for a route change, reload, or tab close while the key is on
	// screen: the generated account is already stored, so don't leave it inactive.
	$effect(() => {
		let activated = false;
		const activate = () => {
			if (activated) return;
			activated = true;
			if (view === 'created' && createdAccount) manager.setActive(createdAccount);
		};
		window.addEventListener('pagehide', activate);
		return () => {
			window.removeEventListener('pagehide', activate);
			activate();
		};
	});

	async function publishName(account: PrivateKeyAccount, name: string) {
		const unsigned = {
			kind: Metadata,
			created_at: Math.floor(Date.now() / 1000),
			tags: [],
			content: JSON.stringify({ name }),
			pubkey: account.pubkey
		};
		const signed = await account.signer.signEvent(unsigned);
		for (const relay of metadataRelays) {
			await relayPool.relay(relay).publish(signed);
		}
		eventStore.add(signed);
	}

	function finishCreated() {
		if (view !== 'created') return;
		const account = createdAccount;
		const name = displayName.trim();
		if (account) manager.setActive(account);
		closeDialog();
		if (account && name) {
			void publishName(account, name).catch((error) => {
				toast.error(error instanceof Error ? error.message : 'Could not publish your name');
			});
		}
	}

	async function generateRemoteSignerUri(openApp = false) {
		try {
			loading = true;
			error = '';

			const signer = new NostrConnectSigner({
				relays: ['wss://relay.primal.net', 'wss://relay.nostr.net', 'wss://nos.lol']
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
			closeDialog();
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
			closeDialog();
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

	function goBack() {
		if (view === 'remote') resetRemoteSignerState();
		error = '';
		view = 'choose';
	}

	// Probe once for installed Android signer apps (Amber, etc.) via NIP-55 on mount of the native
	// shell, so the result is resolved before the dialog opens. Web/iOS never probe (-> null).
	// Best-effort: a missing plugin or zero installed signers resolves to [] and the row is hidden.
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
			closeDialog();
		} catch (err) {
			androidSignerError = err instanceof Error ? err.message : 'Failed to connect signer app';
		} finally {
			connectingPkg = null;
		}
	}

	const hasExtension = $derived(typeof window !== 'undefined' && 'nostr' in window);
	const title = $derived(
		view === 'choose'
			? 'Welcome to Cordn'
			: view === 'import'
				? 'Use an existing key'
				: view === 'remote'
					? 'Remote signer'
					: "You're in."
	);
	const description = $derived(
		view === 'choose'
			? 'Create an identity, or use one you already have.'
			: view === 'created'
				? 'Your account lives in this browser.'
				: 'You can go back at any point.'
	);
	const signerApps = $derived(
		isAndroidNative() && androidSignerApps && androidSignerApps.length > 0 ? androidSignerApps : []
	);
</script>

<Dialog.Root
	bind:open
	onOpenChange={(next) => {
		onOpenChange(next);
		if (!next) {
			dialogState.dialogId = null;
			if (view === 'created') finishCreated();
		}
	}}
>
	<Dialog.Trigger class={triggerClasses}>{triggerLabel}</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>{description}</Dialog.Description>
			{#if context}
				<p class="text-sm text-muted-foreground">{context}</p>
			{/if}
		</Dialog.Header>

		<div class="grid gap-4 py-4">
			{#if view === 'choose'}
				<div class="grid gap-2">
					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-left transition-colors hover:bg-primary/10 disabled:opacity-50"
						disabled={loading}
						onclick={createIdentity}
					>
						{#if loading}
							<Spinner class="size-4 shrink-0" />
						{:else}
							<UserPlus class="size-4 shrink-0" aria-hidden="true" />
						{/if}
						<span class="min-w-0 flex-1">
							<span class="block text-sm font-medium">Create a new identity</span>
							<span class="block text-xs text-muted-foreground"
								>No email, no phone. Takes a second.</span
							>
						</span>
						<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					</button>

					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted/40 disabled:opacity-50"
						disabled={loading}
						onclick={() => (view = 'import')}
					>
						<KeyRound class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="min-w-0 flex-1">
							<span class="block text-sm font-medium">I already have a key</span>
							<span class="block text-xs text-muted-foreground">Paste your nsec or hex key.</span>
						</span>
						<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					</button>

					{#if hasExtension}
						<button
							type="button"
							class="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted/40 disabled:opacity-50"
							disabled={loading}
							onclick={connectExtension}
						>
							{#if loading}
								<Spinner class="size-4 shrink-0" />
							{:else}
								<Puzzle class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							{/if}
							<span class="min-w-0 flex-1">
								<span class="block text-sm font-medium">Use your browser extension</span>
								<span class="block text-xs text-muted-foreground">Your key never leaves it.</span>
							</span>
							<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						</button>
					{/if}

					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted/40 disabled:opacity-50"
						disabled={loading}
						onclick={() => (view = 'remote')}
					>
						<Shield class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<span class="min-w-0 flex-1">
							<span class="block text-sm font-medium">Use a remote signer</span>
							<span class="block text-xs text-muted-foreground">NIP-46 signer app or bunker.</span>
						</span>
						<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					</button>

					{#if signerApps.length > 0}
						<p
							class="px-1 pt-2 text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase"
						>
							Signer apps
						</p>
						{#if androidSignerError}
							<p class="text-sm text-destructive">{androidSignerError}</p>
						{/if}
						{#each signerApps as app (app.packageName)}
							<Button
								variant="outline"
								class="w-full justify-start"
								disabled={connectingPkg !== null || loading}
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
					{/if}
				</div>
			{:else if view === 'import'}
				<div class="space-y-4">
					<div class="space-y-2">
						<Label for="account-import-key">Private key</Label>
						<Input
							id="account-import-key"
							placeholder="nsec1… or 64-character hex"
							bind:value={importKey}
							class="font-mono"
							autocomplete="off"
							onkeydown={(event) => {
								if (event.key === 'Enter' && importKey.trim() && !loading) signInWithKey(importKey);
							}}
						/>
						<p class="text-xs text-muted-foreground">
							Your key stays in this browser. Use an extension or signer app if you'd rather keep it
							out.
						</p>
					</div>
					<Button
						class="w-full"
						onclick={() => signInWithKey(importKey)}
						disabled={loading || !importKey.trim()}
					>
						{#if loading}
							<Spinner class="mr-2 size-4" />
						{/if}
						Sign in
					</Button>
				</div>
			{:else if view === 'created'}
				<div class="space-y-4">
					<SecretKeyReveal account={createdAccount} />
					<div class="space-y-2">
						<Label for="created-name">
							What should people call you?
							<span class="font-normal text-muted-foreground">(optional)</span>
						</Label>
						<Input
							id="created-name"
							placeholder="Your name"
							bind:value={displayName}
							maxlength={64}
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									finishCreated();
								}
							}}
						/>
						<p class="text-xs text-muted-foreground">
							Anyone who can find you sees this. You can change it later.
						</p>
					</div>
				</div>
			{:else if view === 'remote'}
				<div class="space-y-4">
					{#if remoteSignerStep === 'generate'}
						<div class="space-y-4">
							<p class="text-sm text-muted-foreground">
								Connect using a remote signer app that supports NIP-46 (Nostr Connect).
							</p>
							<div class="flex flex-col gap-2">
								<Button class="w-full" onclick={() => generateRemoteSignerUri(true)}>
									Open signer app
								</Button>
								<Button
									variant="outline"
									class="w-full"
									onclick={() => (remoteSignerStep = 'manual')}
								>
									Enter bunker URI
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

							<Button variant="outline" onclick={resetRemoteSignerState}>Cancel</Button>
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
									onkeydown={(event) => {
										if (event.key === 'Enter' && bunkerUri.trim() && !loading) {
											connectWithBunkerUri();
										}
									}}
								/>
								<p class="text-xs text-muted-foreground">
									Enter the bunker URI provided by your signer app.
								</p>
							</div>
							<Button
								class="w-full"
								onclick={connectWithBunkerUri}
								disabled={loading || !bunkerUri.trim()}
							>
								{#if loading}
									<Spinner class="mr-2 size-4" />
								{/if}
								Connect
							</Button>
							<Button variant="outline" onclick={() => (remoteSignerStep = 'generate')}>
								Back to connection options
							</Button>
						</div>
					{/if}
				</div>
			{/if}

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}
		</div>

		<Dialog.Footer class={view === 'created' ? 'justify-end' : 'justify-between'}>
			{#if view === 'created'}
				<Button class="w-full sm:w-auto" onclick={finishCreated}>Continue</Button>
			{:else}
				{#if view === 'choose'}
					<span></span>
				{:else}
					<Button variant="ghost" onclick={goBack} disabled={loading}>Back</Button>
				{/if}
				<Button variant="outline" onclick={closeDialog} disabled={loading}>Cancel</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
