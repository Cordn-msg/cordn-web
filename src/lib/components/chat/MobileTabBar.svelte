<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import QrShareDialog from '$lib/components/QrShareDialog.svelte';
	import Bolt from '@lucide/svelte/icons/bolt';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import QrCodeIcon from '@lucide/svelte/icons/qr-code';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { listChatGroups } from '$lib/services/chatGroups.svelte';
	import {
		getUnreadChatGroupMessageCount,
		getUnreadChatGroupReferenceCount
	} from '$lib/services/chatGroupPresence.svelte';
	import { getUnreadNewsCount } from '$lib/news/newsReadState.svelte';
	import { defaultProfileShareUrl, listProfileShareOptions } from '$lib/utils/profileShareOptions';

	// Mobile primary navigation: three destinations + the home FAB = the app's
	// entire working-memory budget (thumb-zone anchored, Hoober/NN/g — see
	// design discussion). Desktop keeps the persistent sidebar; this bar is
	// mobile-only. Immersive conversation views ([id], [id]/info, …) hide it so
	// the composer owns the bottom edge.
	const isConversationRoute = $derived(page.route.id?.startsWith('/chat/[id]') ?? false);

	let shareOpen = $state(false);

	// Chats badge mirrors the home feed rows exactly (messages + references
	// someone replied to you + news), so a row dot can never exist without a badge.
	const unreadCount = $derived.by(
		() =>
			listChatGroups().reduce(
				(total, group) =>
					total +
					getUnreadChatGroupMessageCount(group.id) +
					getUnreadChatGroupReferenceCount(group.id, $activeAccount?.pubkey ?? ''),
				0
			) + getUnreadNewsCount()
	);

	const chatsHref = $derived(resolve('/chat'));
	const settingsHref = $derived(resolve('/chat/config'));
	const isChatsActive = $derived(page.url.pathname === chatsHref);
	const isSettingsActive = $derived(page.url.pathname.startsWith(settingsHref));

	const shareOptions = $derived.by(() => listProfileShareOptions($activeAccount?.pubkey));
	const shareUrl = $derived.by(() => defaultProfileShareUrl($activeAccount?.pubkey));

	const itemClass =
		'flex min-h-14 flex-col items-center justify-center gap-1 px-2 pt-3 pb-1.5 text-[11px] font-medium transition-colors';
</script>

{#if !isConversationRoute}
	<nav
		aria-label="Primary"
		class="z-40 shrink-0 border-t border-border bg-background pb-safe md:hidden"
	>
		<div class="mx-auto grid max-w-md grid-cols-3">
			<a
				href={chatsHref}
				class="{itemClass} {isChatsActive
					? 'text-foreground'
					: 'text-muted-foreground hover:text-foreground'}"
				aria-current={isChatsActive ? 'page' : undefined}
			>
				<MessageCircle class="size-5" aria-hidden="true" />
				<span class="flex items-center gap-1">
					Chats
					{#if unreadCount > 0}
						<span
							class="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground"
						>
							{unreadCount > 99 ? '99+' : unreadCount}
						</span>
					{/if}
				</span>
			</a>
			<button
				type="button"
				disabled={!$activeAccount}
				title={$activeAccount ? 'Share your profile' : 'Log in to share your profile'}
				class="{itemClass} {$activeAccount
					? shareOpen
						? 'text-foreground'
						: 'text-muted-foreground hover:text-foreground'
					: 'text-muted-foreground/50'}"
				onclick={() => (shareOpen = true)}
			>
				<QrCodeIcon class="size-5" aria-hidden="true" />
				<span>Share</span>
			</button>
			<a
				href={settingsHref}
				class="{itemClass} {isSettingsActive
					? 'text-foreground'
					: 'text-muted-foreground hover:text-foreground'}"
				aria-current={isSettingsActive ? 'page' : undefined}
			>
				<Bolt class="size-5" aria-hidden="true" />
				<span>Settings</span>
			</a>
		</div>
	</nav>

	{#if $activeAccount}
		<QrShareDialog
			bind:open={shareOpen}
			title="Share your profile"
			description="Share your public Cordn profile link as a QR code, or scan someone else's."
			data={shareUrl}
			{shareOptions}
			copyLabel="Copy profile link"
			copiedLabel="Copied profile link"
		/>
	{/if}
{/if}
