<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { Spinner } from '$lib/components/ui/spinner';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import {
		exportClientData,
		importClientData,
		CrossAccountRestoreError,
		type ImportResult
	} from '$lib/services/chatBackup.svelte';
	import { ensureGroupsLoaded, listChatGroups } from '$lib/services/chatGroups.svelte';
	import { toast } from 'svelte-sonner';
	import { nip19 } from 'nostr-tools';
	import Download from '@lucide/svelte/icons/download';
	import Upload from '@lucide/svelte/icons/upload';
	import DatabaseBackup from '@lucide/svelte/icons/database-backup';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';

	let tab = $state<'backup' | 'restore'>('backup');

	let exporting = $state(false);
	let importing = $state(false);
	let importResult = $state<ImportResult | null>(null);

	// Export controls
	let exportMessages = $state(true);
	let exportEncrypted = $state(true);
	let exportPassphrase = $state('');

	// Import controls
	let importEncrypted = $state(true);
	let importPassphrase = $state('');
	let importFile = $state<File | null>(null);
	let confirmOpen = $state(false);
	// Set when import was blocked because the active pubkey isn't in the backup;
	// drives the cross-account warning variant of the confirm dialog.
	let crossAccount = $state<CrossAccountRestoreError | null>(null);

	const groupCount = $derived(listChatGroups().length);

	function downloadBlob(blob: Blob) {
		const pubkey = $activeAccount?.pubkey ?? 'account';
		const date = new Date().toISOString().slice(0, 10);
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `cordn-backup-${pubkey.slice(0, 8)}-${date}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function handleExport() {
		if (!$activeAccount) return;
		if (exportEncrypted && !exportPassphrase) {
			toast.error('Enter a passphrase to encrypt the backup');
			return;
		}
		exporting = true;
		try {
			const blob = await exportClientData({
				includeMessages: exportMessages,
				passphrase: exportEncrypted ? exportPassphrase : null
			});
			downloadBlob(blob);
			toast.success(
				`Backup created${exportEncrypted ? ' (encrypted)' : ''}${exportMessages ? '' : ', messages excluded'}`
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Export failed');
		} finally {
			exporting = false;
		}
	}

	function onFileChosen(event: Event) {
		const target = event.target as HTMLInputElement;
		importFile = target.files?.[0] ?? null;
		importResult = null;
	}

	async function runImport(confirmCrossAccount = false) {
		if (!importFile) return;
		if (importEncrypted && !importPassphrase) {
			toast.error('Enter the backup passphrase');
			return;
		}
		importing = true;
		try {
			importResult = await importClientData(importFile, {
				passphrase: importEncrypted ? importPassphrase : null,
				confirmCrossAccount
			});
			crossAccount = null;
			confirmOpen = false;
			await ensureGroupsLoaded();
			toast.success(
				`Restored ${importResult.groups} group${importResult.groups === 1 ? '' : 's'}, ${importResult.accounts} account(s)`
			);
		} catch (error) {
			if (error instanceof CrossAccountRestoreError) {
				// Surface the mismatch in the existing dialog instead of toasting;
				// the user must explicitly confirm the identity switch.
				crossAccount = error;
				confirmOpen = true;
			} else {
				importResult = null;
				toast.error(error instanceof Error ? error.message : 'Import failed');
			}
		} finally {
			importing = false;
		}
	}

	const activeNpub = $derived(
		crossAccount ? nip19.npubEncode(crossAccount.activePubkey).slice(0, 16) : ''
	);
	const backupNpub = $derived(
		crossAccount && crossAccount.backupPubkeys[0]
			? nip19.npubEncode(crossAccount.backupPubkeys[0]).slice(0, 16)
			: ''
	);
</script>

<svelte:head>
	<title>Backup & recovery | Cordn</title>
	<meta
		name="description"
		content="Export and import local Cordn client data — accounts, MLS group secrets, and coordinators."
	/>
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<DatabaseBackup class="size-4" />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">Backup & recovery</h1>
				<p class="text-sm text-muted-foreground">
					Export your account, group secrets, and coordinators for recovery.
				</p>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto grid max-w-3xl gap-6">
			{#if !$activeAccount}
				<Card.Root>
					<Card.Header>
						<Card.Title>Log in required</Card.Title>
						<Card.Description
							>Backups are scoped to the active account. Log in to continue.</Card.Description
						>
					</Card.Header>
					<Card.Content>
						<div class="space-y-3">
							<p class="text-sm text-muted-foreground">
								Your private keys, group secrets, and coordinators back up against the active
								identity.
							</p>
							<AccountLoginDialog />
						</div>
					</Card.Content>
				</Card.Root>
			{:else}
				<!-- Tab navigation -->
				<div class="flex space-x-1 rounded-lg bg-muted p-1">
					<button
						class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab ===
						'backup'
							? 'bg-background shadow-sm'
							: 'hover:bg-muted-foreground/10'}"
						onclick={() => (tab = 'backup')}
					>
						Backup
					</button>
					<button
						class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {tab ===
						'restore'
							? 'bg-background shadow-sm'
							: 'hover:bg-muted-foreground/10'}"
						onclick={() => (tab = 'restore')}
					>
						Restore
					</button>
				</div>

				{#if tab === 'backup'}
					<Card.Root>
						<Card.Header>
							<Card.Title>Export backup</Card.Title>
							<Card.Description>
								Includes the active account's private keys, {groupCount}
								group{groupCount === 1 ? '' : 's'} with MLS secrets, and saved coordinators.
							</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-4">
							<div class="flex items-center justify-between rounded-lg border border-border p-3">
								<div>
									<p class="text-sm font-medium">Encrypt with passphrase</p>
									<p class="text-xs text-muted-foreground">
										Strongly recommended — the file contains private keys.
									</p>
								</div>
								<Switch bind:checked={exportEncrypted} />
							</div>

							{#if exportEncrypted}
								<div class="space-y-2">
									<Label for="export-passphrase">Passphrase</Label>
									<Input
										id="export-passphrase"
										type="password"
										bind:value={exportPassphrase}
										placeholder="Choose a strong passphrase"
										autocomplete="new-password"
									/>
									<p class="text-xs text-muted-foreground">
										Use at least 8 characters; longer is better. There is no recovery if you forget
										it.
									</p>
								</div>
							{/if}

							<div class="flex items-center justify-between rounded-lg border border-border p-3">
								<div>
									<p class="text-sm font-medium">Include message history</p>
									<p class="text-xs text-muted-foreground">
										Off exports only group secrets; messages re-stream on restore.
									</p>
								</div>
								<Switch bind:checked={exportMessages} />
							</div>

							<Button onclick={handleExport} disabled={exporting} class="w-full">
								{#if exporting}
									<Spinner class="mr-2 size-4" />
									Exporting…
								{:else}
									<Download class="mr-2 size-4" />
									Export backup
								{/if}
							</Button>
						</Card.Content>
					</Card.Root>
				{:else}
					<Card.Root>
						<Card.Header>
							<Card.Title>Restore backup</Card.Title>
							<Card.Description>
								Import a backup file. Groups are upserted by id. Accounts already present on this
								device (same pubkey) keep their working sign-in method; the backup only adds
								identities not yet here.
							</Card.Description>
						</Card.Header>
						<Card.Content class="space-y-4">
							<div class="space-y-2">
								<Label for="import-file">Backup file</Label>
								<Input
									id="import-file"
									type="file"
									accept="application/json,.json"
									onchange={onFileChosen}
								/>
							</div>

							<div class="flex items-center justify-between rounded-lg border border-border p-3">
								<div>
									<p class="text-sm font-medium">Encrypted backup</p>
									<p class="text-xs text-muted-foreground">
										Turn off if the file was exported without a passphrase.
									</p>
								</div>
								<Switch bind:checked={importEncrypted} />
							</div>

							{#if importEncrypted}
								<div class="space-y-2">
									<Label for="import-passphrase">Passphrase</Label>
									<Input
										id="import-passphrase"
										type="password"
										bind:value={importPassphrase}
										placeholder="Backup passphrase"
										autocomplete="off"
									/>
								</div>
							{/if}

							<Button
								onclick={() => {
									crossAccount = null;
									confirmOpen = true;
								}}
								disabled={!importFile || importing}
								variant="secondary"
								class="w-full"
							>
								{#if importing}
									<Spinner class="mr-2 size-4" />
									Restoring…
								{:else}
									<Upload class="mr-2 size-4" />
									Restore backup
								{/if}
							</Button>

							{#if importResult}
								<p class="text-sm text-muted-foreground">
									Restored {importResult.groups} group{importResult.groups === 1 ? '' : 's'}, {importResult.accounts}
									account(s), {importResult.coordinators}
									coordinator(s).
								</p>
							{/if}
						</Card.Content>
					</Card.Root>
				{/if}

				<div
					class="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200"
				>
					<ShieldAlert class="size-5 shrink-0" />
					<div class="space-y-1">
						<p class="font-medium">Keep backups safe</p>
						<p class="text-muted-foreground">
							An unencrypted backup, or anyone with the passphrase, fully controls your identity and
							can read all group history. Store it like a private key.
						</p>
					</div>
				</div>
			{/if}

			<div class="text-center">
				<a href={resolve('/chat/config')} class="text-sm text-muted-foreground hover:underline">
					Back to config
				</a>
			</div>
		</div>
	</div>
</div>

<Dialog.Root bind:open={confirmOpen}>
	<Dialog.Content class="sm:max-w-[425px]">
		{#if crossAccount}
			<Dialog.Header>
				<Dialog.Title>Different account detected</Dialog.Title>
				<Dialog.Description>
					You are logged in as <span class="font-mono">{activeNpub}…</span> but this backup belongs
					to <span class="font-mono">{backupNpub}…</span>. Restoring it will switch your active
					account. Your current account is preserved — switch back anytime from the account menu.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex justify-end gap-2 pt-4">
				<Button variant="outline" onclick={() => (confirmOpen = false)}>Cancel</Button>
				<Button variant="destructive" onclick={() => runImport(true)}>
					Switch account &amp; restore
				</Button>
			</div>
		{:else}
			<Dialog.Header>
				<Dialog.Title>Restore this backup?</Dialog.Title>
				<Dialog.Description>
					This activates the backup's account (using the local sign-in method if that identity is
					already on this device) and adds its groups and coordinators. Existing groups with
					matching ids are upserted.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex justify-end gap-2 pt-4">
				<Button variant="outline" onclick={() => (confirmOpen = false)}>Cancel</Button>
				<Button onclick={() => runImport(false)}>Restore</Button>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
