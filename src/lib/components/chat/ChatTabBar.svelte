<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import QrShareDialog from '$lib/components/QrShareDialog.svelte';
	import NewConversationDialog from '$lib/components/chat/NewConversationDialog.svelte';
	import NotificationsDialog from '$lib/components/chat/NotificationsDialog.svelte';
	import Bolt from '@lucide/svelte/icons/bolt';
	import Inbox from '@lucide/svelte/icons/inbox';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import Plus from '@lucide/svelte/icons/plus';
	import QrCodeIcon from '@lucide/svelte/icons/qr-code';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import { hasUnreadChatAttention } from '$lib/services/chatAttention.svelte';
	import { getUnreadJoinRequestCount } from '$lib/services/chatJoinRequests.svelte';
	import { getUnreadWelcomeNotificationCount } from '$lib/services/chatWelcomeNotifications.svelte';
	import { defaultProfileShareUrl, listProfileShareOptions } from '$lib/utils/profileShareOptions';

	// Primary navigation on every viewport (desktop included): four tab
	// destinations plus a center “+” action (the old floating FAB, folded into
	// the bar). Immersive conversation views ([id], [id]/info, …) hide it so the
	// composer owns the bottom edge; on desktop the persistent sidebar also
	// navigates out of those.
	const isConversationRoute = $derived(page.route.id?.startsWith('/chat/[id]') ?? false);

	let shareOpen = $state(false);
	let notificationsOpen = $state(false);
	let newConversationOpen = $state(false);

	// Chats dot mirrors the hamburger exactly (same attention source in
	// chatAttention: messages, references, invites, join requests, news).
	const hasUnreadChats = $derived(hasUnreadChatAttention());

	const hasUnreadNotifications = $derived.by(
		() => getUnreadWelcomeNotificationCount() + getUnreadJoinRequestCount() > 0
	);

	const chatsHref = $derived(resolve('/chat'));
	const newsHref = $derived(resolve('/chat/news'));
	const settingsHref = $derived(resolve('/chat/config'));
	const coordinatorsHref = $derived(resolve('/chat/coordinators'));
	// News is a child of the chats home (its back button goes there), so the
	// Chats tab stays lit on it.
	const isChatsActive = $derived(page.url.pathname === chatsHref || page.url.pathname === newsHref);
	// Coordinators lives under settings in the IA (its back button goes there),
	// so the Settings tab stays lit on it too.
	const isSettingsActive = $derived(
		page.url.pathname.startsWith(settingsHref) || page.url.pathname.startsWith(coordinatorsHref)
	);

	const shareOptions = $derived.by(() => listProfileShareOptions($activeAccount?.pubkey));
	const shareUrl = $derived.by(() => defaultProfileShareUrl($activeAccount?.pubkey));

	const itemClass =
		'flex min-h-14 flex-col items-center justify-center gap-1 px-2 pt-3 pb-1.5 text-[11px] font-medium transition-colors';
</script>

{#if !isConversationRoute}
	<nav aria-label="Primary" class="z-40 shrink-0 border-t border-border bg-background pb-safe">
		<div class="mx-auto grid max-w-md grid-cols-5">
			<a
				href={chatsHref}
				class="{itemClass} {isChatsActive
					? 'text-foreground'
					: 'text-muted-foreground hover:text-foreground'}"
				aria-current={isChatsActive ? 'page' : undefined}
			>
				<MessageCircle class="size-5" aria-hidden="true" />
				<span class="flex items-center gap-1.5">
					Chats
					{#if hasUnreadChats}
						<span class="h-2 w-2 rounded-full bg-red-500" aria-hidden="true"></span>
					{/if}
				</span>
			</a>
			<button
				type="button"
				disabled={!$activeAccount}
				title={$activeAccount ? 'Invitations and join requests' : 'Log in to see notifications'}
				class="{itemClass} {$activeAccount
					? notificationsOpen
						? 'text-foreground'
						: 'text-muted-foreground hover:text-foreground'
					: 'text-muted-foreground/50'}"
				onclick={() => (notificationsOpen = true)}
			>
				<Inbox class="size-5" aria-hidden="true" />
				<span class="flex items-center gap-1.5">
					Notifications
					{#if hasUnreadNotifications}
						<span class="h-2 w-2 rounded-full bg-red-500" aria-hidden="true"></span>
					{/if}
				</span>
			</button>
			<button
				type="button"
				title="New conversation"
				aria-label="New conversation"
				class="flex min-h-14 items-center justify-center px-2"
				onclick={() => (newConversationOpen = true)}
			>
				<span
					class="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-transform active:scale-95"
				>
					<Plus class="size-5" aria-hidden="true" />
				</span>
			</button>
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

	<NewConversationDialog bind:open={newConversationOpen} />

	{#if $activeAccount}
		<NotificationsDialog bind:open={notificationsOpen} />
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
