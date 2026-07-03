<script lang="ts">
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import GroupAvatarFallback from './GroupAvatarFallback.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { resolveWelcomeDisplayName } from '$lib/components/chat/chatGroupDisplay';
	import { activeAccount } from '$lib/services/accountManager.svelte';
	import type { ProfileHints } from '$lib/services/useProfileHints.svelte';
	import type { WelcomeNotificationEntry } from '$lib/services/chatWelcomeNotifications.svelte';

	let {
		notification,
		profileHints,
		showReject = true,
		showCoordinatorLabel = true,
		acceptedGroupLabel = 'a local group',
		coordinatorLabel = '',
		submitting = false,
		onAccept,
		onReject
	}: {
		notification: WelcomeNotificationEntry;
		profileHints: ProfileHints;
		showReject?: boolean;
		showCoordinatorLabel?: boolean;
		acceptedGroupLabel?: string;
		coordinatorLabel?: string;
		submitting?: boolean;
		onAccept: () => void;
		onReject?: () => void;
	} = $props();
</script>

<div
	class="overflow-hidden rounded-lg border px-3 py-2.5 {notification.readAt
		? 'border-border bg-background/50'
		: 'border-primary/40 bg-primary/5'}"
>
	<div class="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
		<div class="flex min-w-0 gap-2.5">
			<Avatar class="h-9 w-9 shrink-0 border border-border bg-background">
				{#if notification.preview?.imageUrl}
					<AvatarImage
						src={notification.preview.imageUrl}
						alt={notification.preview.name}
						class="object-cover"
					/>
				{/if}
				<AvatarFallback class="bg-background text-xs font-medium">
					<GroupAvatarFallback icon={notification.preview?.icon} />
				</AvatarFallback>
			</Avatar>
			<div class="min-w-0 flex-1 space-y-0.5 overflow-hidden">
				<p class="truncate text-sm font-medium sm:whitespace-normal">
					{resolveWelcomeDisplayName({
						welcomeName: notification.preview?.name ?? '',
						profileHints,
						memberPubkeys: notification.preview?.memberPubkeys,
						activePubkey: $activeAccount?.pubkey
					})}
				</p>
				{#if notification.preview?.description}
					<p class="line-clamp-2 text-xs break-words text-muted-foreground">
						{notification.preview.description}
					</p>
				{/if}
				{#if showCoordinatorLabel && coordinatorLabel}
					<p class="truncate text-[11px] text-muted-foreground">
						{coordinatorLabel}
					</p>
				{/if}
				<p class="text-[11px] text-muted-foreground">
					{new Date(notification.at).toLocaleString()}
				</p>
				{#if notification.acceptedGroupId}
					<p class="text-[11px] text-emerald-600 dark:text-emerald-400">
						Accepted into {acceptedGroupLabel}
					</p>
				{/if}
			</div>
		</div>
		<div class="flex flex-wrap gap-1.5 sm:max-w-[13rem] sm:justify-end">
			{#if !notification.acceptedGroupId}
				<Button type="button" size="sm" class="h-8 px-3" onclick={onAccept} disabled={submitting}>
					{#if submitting}
						<Spinner class="mr-1 size-3" />
					{/if}
					{submitting ? 'Accepting…' : 'Accept'}
				</Button>
				{#if showReject && onReject}
					<Button
						type="button"
						variant="destructive"
						size="sm"
						class="h-8 px-3"
						onclick={onReject}
						disabled={submitting}
					>
						{#if submitting}
							<Spinner class="mr-1 size-3" />
						{/if}
						{submitting ? 'Rejecting…' : 'Reject'}
					</Button>
				{/if}
			{/if}
		</div>
	</div>
</div>
