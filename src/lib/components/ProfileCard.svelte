<script lang="ts">
	import { addressLoader } from '$lib/services/loaders.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { eventStore } from '../services/eventStore';
	import { ProfileModel } from 'applesauce-core/models';
	import Button from './ui/button/button.svelte';
	import LogOut from '@lucide/svelte/icons/log-out';
	import { logout } from '$lib/services/accountManager.svelte';
	import { pubkeyToHexColor } from '$lib/utils';
	import { Metadata } from 'nostr-tools/kinds';
	import { cn } from '$lib/utils';
	import { copyToClipboard } from '$lib/utils';

	let {
		pubkey,
		mode = 'compact',
		showLogout = false,
		showName = true,
		showInlineAvatar = false
	}: {
		pubkey: string;
		mode?: 'compact' | 'extended' | 'inline';
		showLogout?: boolean;
		showName?: boolean;
		showInlineAvatar?: boolean;
		inlineClass?: string;
	} = $props();

	const isExtended = $derived(mode === 'extended');
	const isInline = $derived(mode === 'inline');
	const canShowLogout = $derived(mode === 'compact' && showLogout);

	const profile = $derived(eventStore.model(ProfileModel, pubkey));
	const displayName = $derived(
		$profile?.name || $profile?.display_name || $profile?.nip05 || pubkey.slice(0, 8)
	);

	async function copyPubkey() {
		await copyToClipboard(pubkey);
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
	{#if pfp}
		<img
			src={pfp}
			alt="pfp"
			class={cn(
				'rounded-full object-cover',
				size === 'extended' ? 'h-16 w-16' : size === 'inline' ? 'h-4 w-4 shrink-0' : 'h-8 w-8'
			)}
		/>
	{:else}
		<div
			class={cn(
				'rounded-full',
				size === 'extended' ? 'h-16 w-16' : size === 'inline' ? 'h-4 w-4 shrink-0' : 'h-8 w-8'
			)}
			style="background-color: {pubkeyToHexColor(pubkey)}"
		></div>
	{/if}
{/snippet}
{#if isExtended}
	<div class="overflow-hidden rounded-lg border border-border bg-card">
		{#if $profile?.banner}
			<img src={$profile.banner} alt="" class="h-32 w-full object-cover" />
		{/if}

		<div class="p-4">
			<div class="flex items-start gap-3">
				{@render pfp(pubkey, $profile?.picture, 'extended')}
				<div class="min-w-0 flex-1 pt-1">
					<button
						type="button"
						class="block w-full truncate text-left text-lg font-semibold"
						onclick={copyPubkey}
					>
						{displayName}
					</button>
					{#if $profile?.nip05}
						<p class="text-xs text-muted-foreground">{$profile.nip05}</p>
					{/if}
				</div>

				{#if showLogout}
					<Button variant="ghost" size="icon" onclick={logout} aria-label="Logout">
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
		<button type="button" class="inline min-w-0 text-left" onclick={copyPubkey}
			>{displayName}</button
		>
	</span>
{:else}
	<div class="flex items-center gap-2">
		{@render pfp(pubkey, $profile?.picture)}
		{#if showName}
			<div class="min-w-0 flex-1">
				<button
					type="button"
					class="block w-full truncate text-left text-sm font-semibold"
					onclick={copyPubkey}
				>
					{displayName}
				</button>
				{#if $profile?.nip05}
					<p class="text-xs text-muted-foreground">{$profile.nip05}</p>
				{/if}
			</div>
		{/if}

		{#if canShowLogout}
			<Button variant="ghost" size="icon" onclick={logout} aria-label="Logout">
				<LogOut class="h-4 w-4" />
			</Button>
		{/if}
	</div>
{/if}
