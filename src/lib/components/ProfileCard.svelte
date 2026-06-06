<script lang="ts">
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '../services/eventStore';
	import { ProfileModel } from 'applesauce-core/models';
	import Button, { type ButtonVariant } from './ui/button/button.svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import LogOut from '@lucide/svelte/icons/log-out';
	import { logout } from '$lib/services/accountManager.svelte';
	import { cleanupActiveAccountChatData } from '$lib/services/chatSession.svelte';
	import { pubkeyToHexColor } from '$lib/utils';
	import { Metadata } from 'nostr-tools/kinds';
	import { nip19 } from 'nostr-tools';
	import { cn } from '$lib/utils';
	import { copyToClipboard } from '$lib/utils';
	import { resolve } from '$app/paths';

	let {
		pubkey,
		mode = 'compact',
		showLogout = false,
		showName = true,
		showInlineAvatar = false,
		logoutButtonVariant = 'ghost',
		profileLink = true
	}: {
		pubkey: string;
		mode?: 'compact' | 'extended' | 'inline';
		showLogout?: boolean;
		showName?: boolean;
		showInlineAvatar?: boolean;
		logoutButtonVariant?: ButtonVariant;
		profileLink?: boolean;
	} = $props();

	let showLogoutDialog = $state(false);
	let logoutCleaning = $state(false);

	const isExtended = $derived(mode === 'extended');
	const isInline = $derived(mode === 'inline');
	const canShowLogout = $derived(mode === 'compact' && showLogout);

	const profile = $derived(eventStore.model(ProfileModel, pubkey));
	const npub = $derived(nip19.npubEncode(pubkey));
	const displayName = $derived(
		$profile?.name || $profile?.display_name || $profile?.nip05 || `${npub.slice(0, 12)}…`
	);

	async function copyPubkey() {
		await copyToClipboard(npub);
	}

	const profileHref = $derived.by(() => resolve('/p/[identifier]', { identifier: npub }));

	async function cleanAndLogout() {
		logoutCleaning = true;
		try {
			await cleanupActiveAccountChatData();
			showLogoutDialog = false;
		} finally {
			logoutCleaning = false;
		}
	}
	$effect(() => {
		if ($profile) return;
		const sub = addressLoader({
			kind: Metadata,
			pubkey,
			relays: metadataRelays
		}).subscribe();
		return () => sub.unsubscribe();
	});
</script>

{#snippet pfp(pubkey: string, pfp?: string, size: 'compact' | 'extended' | 'inline' = 'compact')}
	{#if profileLink}
		<a href={profileHref} class="shrink-0" aria-label={`Open profile for ${displayName}`}>
			{#if pfp}
				<img
					src={pfp}
					alt="pfp"
					class={cn(
						'rounded-full object-cover',
						size === 'extended' ? 'h-16 w-16' : size === 'inline' ? 'h-6 w-6 shrink-0' : 'h-8 w-8'
					)}
				/>
			{:else}
				<div
					class={cn(
						'rounded-full',
						size === 'extended' ? 'h-16 w-16' : size === 'inline' ? 'h-6 w-6 shrink-0' : 'h-8 w-8'
					)}
					style="background-color: {pubkeyToHexColor(pubkey)}"
				></div>
			{/if}
		</a>
	{:else}
		<span class="shrink-0" aria-hidden="true">
			{#if pfp}
				<img
					src={pfp}
					alt="pfp"
					class={cn(
						'rounded-full object-cover',
						size === 'extended' ? 'h-16 w-16' : size === 'inline' ? 'h-6 w-6 shrink-0' : 'h-8 w-8'
					)}
				/>
			{:else}
				<div
					class={cn(
						'rounded-full',
						size === 'extended' ? 'h-16 w-16' : size === 'inline' ? 'h-6 w-6 shrink-0' : 'h-8 w-8'
					)}
					style="background-color: {pubkeyToHexColor(pubkey)}"
				></div>
			{/if}
		</span>
	{/if}
{/snippet}
{#if isExtended}
	<div class="w-full overflow-hidden rounded-lg border border-border bg-card">
		{#if $profile?.banner}
			<img src={$profile.banner} alt="" class="h-32 w-full object-cover" />
		{/if}

		<div class="p-4">
			<div class="flex items-start gap-3">
				{@render pfp(pubkey, $profile?.picture, 'extended')}
				<div class="min-w-0 flex-1 pt-1">
					<button
						type="button"
						class="block w-full cursor-pointer truncate text-left text-lg font-semibold"
						onclick={copyPubkey}
					>
						{#if profileLink}
							<a
								href={profileHref}
								class="block truncate text-lg font-semibold hover:underline"
								onclick={(event) => event.stopPropagation()}
							>
								{displayName}
							</a>
						{:else}
							<span class="block truncate text-lg font-semibold">{displayName}</span>
						{/if}
					</button>
					{#if $profile?.nip05}
						<p class="text-xs text-muted-foreground">{$profile.nip05}</p>
					{/if}
				</div>

				{#if showLogout}
					<Button
						variant={logoutButtonVariant}
						size="icon"
						onclick={() => (showLogoutDialog = true)}
						aria-label="Logout"
					>
						<LogOut class="h-4 w-4" />
					</Button>
				{/if}
			</div>

			<p class="mt-4 text-sm whitespace-pre-wrap text-muted-foreground">
				{$profile?.about || 'No profile description available.'}
			</p>
		</div>
	</div>
{:else if isInline}
	<span
		class="inline-flex max-w-full items-center gap-1.5 align-baseline text-sm font-medium break-words text-current"
	>
		{#if showInlineAvatar}
			{@render pfp(pubkey, $profile?.picture, 'inline')}
		{/if}
		{#if profileLink}
			<a href={profileHref} class="inline min-w-0 text-left hover:underline">{displayName}</a>
		{:else}
			<span class="inline min-w-0 text-left">{displayName}</span>
		{/if}
	</span>
{:else}
	<div class="flex items-center gap-2">
		{@render pfp(pubkey, $profile?.picture)}
		{#if showName}
			<div class="min-w-0 flex-1">
				<div class="flex min-w-0 flex-wrap items-center gap-2">
					{#if profileLink}
						<a href={profileHref} class="block truncate text-lg font-semibold hover:underline">
							{displayName}
						</a>
					{:else}
						<span class="block truncate text-lg font-semibold">{displayName}</span>
					{/if}
				</div>
				{#if $profile?.nip05}
					<p class="text-xs text-muted-foreground">{$profile.nip05}</p>
				{/if}
			</div>
		{/if}

		{#if canShowLogout}
			<Button
				variant={logoutButtonVariant}
				size="icon"
				class={showName ? '' : 'shrink-0'}
				onclick={() => (showLogoutDialog = true)}
				aria-label="Logout"
			>
				<LogOut class="h-4 w-4" />
			</Button>
		{/if}
	</div>
{/if}

<Dialog.Root bind:open={showLogoutDialog}>
	<Dialog.Content class="sm:max-w-[425px]">
		<Dialog.Header>
			<Dialog.Title>Log out?</Dialog.Title>
			<Dialog.Description>
				Log out keeps this account and its local chat data on this device. Use the cleanup option to
				remove local chat data for this account before logging out.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (showLogoutDialog = false)}>Cancel</Button>
			<Button variant="outline" onclick={cleanAndLogout} disabled={logoutCleaning}>
				Log out and clean data
			</Button>
			<Button
				variant="destructive"
				onclick={() => {
					showLogoutDialog = false;
					logout();
				}}
				disabled={logoutCleaning}
			>
				Log out
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
