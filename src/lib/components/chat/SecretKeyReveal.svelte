<script lang="ts">
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { hasConfirmedBackup, markBackupConfirmed } from '$lib/services/onboarding.svelte';
	import type { PrivateKeyAccount } from 'applesauce-accounts/accounts';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { copyToClipboard } from '$lib/utils';
	import { hexToBytes } from 'nostr-tools/utils';
	import { nsecEncode } from 'nostr-tools/nip19';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';

	let {
		account: providedAccount = undefined
	}: {
		/** Lets the create-identity dialog reveal the key before it is active. */
		account?: PrivateKeyAccount | null;
	} = $props();

	// Keyed by pubkey so switching accounts collapses the reveal instead of
	// showing the next identity's key.
	let revealedFor = $state('');

	const account = $derived(providedAccount ?? $activeAccount);

	// Only locally held keys can be revealed; extension and signer accounts keep
	// the secret out of this tab by design.
	const secret = $derived.by(() => {
		const current = account;
		if (!current || current.type !== 'nsec') return null;
		const key = (current.toJSON().signer as { key?: string } | undefined)?.key;
		if (!key) return null;
		try {
			return nsecEncode(hexToBytes(key));
		} catch {
			return null;
		}
	});
	const confirmed = $derived(hasConfirmedBackup(account?.pubkey));
	const isRevealed = $derived(Boolean(secret) && revealedFor === account?.pubkey);
</script>

{#if secret}
	<div class="space-y-3">
		{#if !isRevealed}
			<div class="space-y-2">
				<p class="text-xs text-muted-foreground">
					Your key is the only way back into this account. Anyone with it can read your chats and
					post as you.
				</p>
				<Button variant="outline" onclick={() => (revealedFor = account?.pubkey ?? '')}>
					Show secret key
				</Button>
			</div>
		{:else}
			<div class="space-y-2">
				<div class="flex gap-2">
					<Input
						value={secret}
						readonly
						class="font-mono"
						onclick={(event) => (event.target as HTMLInputElement).select()}
						aria-label="Secret key"
					/>
					<Button
						variant="outline"
						size="icon"
						class="shrink-0"
						onclick={() => copyToClipboard(secret)}
						aria-label="Copy secret key"
					>
						<Copy class="size-4" />
					</Button>
				</div>
				<p class="text-xs text-muted-foreground">
					Anyone with this key can read your chats and post as you. Store it like a password.
				</p>
				<div class="flex flex-wrap items-center gap-3">
					{#if confirmed}
						<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
							<Check class="size-3.5" aria-hidden="true" />
							Saved
						</p>
					{:else}
						<Button
							variant="secondary"
							size="sm"
							onclick={() => markBackupConfirmed(account?.pubkey)}
						>
							I've saved it
						</Button>
					{/if}
					<button
						type="button"
						class="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						onclick={() => (revealedFor = '')}
					>
						Hide key
					</button>
				</div>
			</div>
		{/if}
	</div>
{/if}
