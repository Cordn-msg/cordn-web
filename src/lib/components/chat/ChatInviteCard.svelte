<script lang="ts">
	import { toast } from 'svelte-sonner';
	import Server from '@lucide/svelte/icons/server';
	import { getChatGroup } from '$lib/services/chatGroups.svelte';
	import { getChatCoordinator, getCoordinatorLabel } from '$lib/services/chatCoordinators.svelte';
	import { useProfileHints } from '$lib/services/useProfileHints.svelte';
	import { metadataRelays } from '$lib/services/relay-pool';
	import { openMessageLink } from '$lib/utils/groupShareLink';
	import { cn, copyToClipboard, normalizePubKey, pubkeyToHexColor } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import ChatGroupAvatar from './ChatGroupAvatar.svelte';
	import GroupAvatarFallback from './GroupAvatarFallback.svelte';
	import type { ChatInvite } from '$lib/chat/chatInvites';

	/**
	 * A cordn invite inside a message (Staircase's InviteCard pattern): what the
	 * link leads to, whether we already have it, and one action to open it. The
	 * bubble's body text no longer repeats the link — the card stands in for it,
	 * with Copy link and a monospace Show link for the raw form.
	 */
	let { invite, isOwn = false }: { invite: ChatInvite; isOwn?: boolean } = $props();

	let showLink = $state(false);

	// Local awareness: a group we're in opens straight to the chat; a
	// coordinator we're on opens; anything else is a join.
	const localGroup = $derived(invite.kind === 'group' ? getChatGroup(invite.gid) : undefined);
	const joinedGroup = $derived(Boolean(localGroup));
	const knownCoordinator = $derived(
		invite.kind === 'coordinator' ? Boolean(getChatCoordinator(invite.pubkey)) : false
	);

	const profileHints = useProfileHints(() => (invite.kind === 'profile' ? [invite.pubkey] : []), {
		relays: metadataRelays
	});

	const kindLabel = $derived(
		invite.kind === 'group' ? 'group' : invite.kind === 'coordinator' ? 'coordinator' : 'profile'
	);

	const shortKey = $derived.by(() => {
		const key = invite.kind === 'group' ? invite.gid : invite.pubkey;
		return key.length > 16 ? `${key.slice(0, 8)}…` : key;
	});

	const title = $derived.by(() => {
		if (invite.kind === 'group') {
			const localName = localGroup?.metadata?.name?.trim();
			if (localName && !localName.startsWith(':direct_chat:')) return localName;
			return invite.name ?? `Group ${invite.gid.slice(0, 8)}…`;
		}
		if (invite.kind === 'coordinator') return invite.label ?? getCoordinatorLabel(invite.pubkey);
		const profile = profileHints[invite.pubkey];
		return profile?.name || profile?.displayName || shortKey;
	});

	const detail = $derived.by(() => {
		if (invite.kind === 'group') {
			const coordinator = invite.coordinatorPubkey
				? `on ${getCoordinatorLabel(normalizePubKey(invite.coordinatorPubkey))}`
				: 'on your default coordinator';
			// The kind label above already says what this is — an unknown group
			// shows just its coordinator, no generic filler line.
			return `${joinedGroup ? "You're in this group · " : ''}${coordinator}`;
		}
		if (invite.kind === 'coordinator') {
			return knownCoordinator
				? "You're on this coordinator"
				: 'Join it so people there can add you to groups';
		}
		return 'Cordn profile';
	});

	const action = $derived.by(() => {
		if (invite.kind === 'group') {
			if (!joinedGroup) return 'Join';
			if (invite.target.type === 'message') return 'Show message';
			if (invite.target.type === 'info') return 'Group info';
			return 'Open chat';
		}
		if (invite.kind === 'coordinator') return knownCoordinator ? 'Open' : 'Join';
		return 'View profile';
	});

	async function copyLink() {
		await copyToClipboard(invite.href);
		toast('Link copied');
	}
</script>

<div
	class={cn(
		'mt-1.5 w-full max-w-[min(100%,24rem)] rounded-xl border p-3 text-left',
		isOwn ? 'border-primary-foreground/25' : 'border-border/60'
	)}
>
	<div class="flex items-center gap-2.5">
		{#if joinedGroup && localGroup}
			<ChatGroupAvatar group={localGroup} class="h-10 w-10 shrink-0" fallbackClass="text-sm" />
		{:else if invite.kind === 'group'}
			<!-- The share metadata's icon is an emoji (not an image URL) — the same
				GroupAvatarFallback every other group avatar uses renders it, with
				the Cordn logo when the link carries none. Never an <img> with a
				non-URL src (the broken-link look). -->
			<span
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-lg"
			>
				<GroupAvatarFallback icon={invite.icon} />
			</span>
		{:else}
			<span
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
				style={`background-color: ${pubkeyToHexColor(invite.pubkey)}`}
			>
				{#if invite.kind === 'coordinator'}
					<Server class="size-5" />
				{:else}
					{title.slice(0, 1).toUpperCase()}
				{/if}
			</span>
		{/if}
		<div class="min-w-0 flex-1">
			<p class="text-[11px] font-semibold tracking-wide uppercase opacity-70">
				Cordn invite · {kindLabel}
			</p>
			<p class="truncate text-sm font-semibold">{title}</p>
			<p class="truncate text-xs opacity-75">{detail}</p>
		</div>
	</div>
	{#if showLink}
		<!-- w-0 min-w-full: zero max-content contribution so an unbroken URL
			can't stretch the shrink-to-fit bubble wide (the empty side margin on
			desktop); min-w-full stretches it to the card's real width at layout. -->
		<code class="mt-2 block w-0 min-w-full rounded bg-black/10 px-1.5 py-1 text-[11px] break-all">
			{invite.href}
		</code>
	{/if}
	<div class="mt-2.5 flex flex-wrap items-center gap-1.5">
		<Button size="sm" onclick={() => void openMessageLink(invite.href)}>{action}</Button>
		<Button size="sm" variant="ghost" onclick={() => void copyLink()}>Copy link</Button>
		<Button size="sm" variant="ghost" onclick={() => (showLink = !showLink)}>
			{showLink ? 'Hide link' : 'Show link'}
		</Button>
	</div>
</div>
