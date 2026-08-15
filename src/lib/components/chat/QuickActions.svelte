<script lang="ts">
	import { browser } from '$app/environment';
	import ChatActionIcons from './ChatActionIcons.svelte';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { getUnreadWelcomeNotificationCount } from '$lib/services/chatWelcomeNotifications.svelte';
	import { getUnreadJoinRequestCount } from '$lib/services/chatJoinRequests.svelte';

	let {
		storageKey,
		defaultOpen = false,
		layout = 'vertical',
		onNavigate = () => {}
	}: {
		/** localStorage key remembering the open/closed choice for this surface. */
		storageKey: string;
		defaultOpen?: boolean;
		layout?: 'vertical' | 'horizontal';
		onNavigate?: () => void;
	} = $props();

	// Deliberate init-once capture of the props (no live prop watching needed).
	// svelte-ignore state_referenced_locally
	const stored = browser ? localStorage.getItem(storageKey) : null;
	// svelte-ignore state_referenced_locally
	let open = $state(stored === null ? defaultOpen : stored === '1');

	$effect(() => {
		if (browser) localStorage.setItem(storageKey, open ? '1' : '0');
	});

	// Attention dot: unread invitations/join requests while the actions are hidden.
	const unreadNotificationTotal = $derived.by(
		() => getUnreadWelcomeNotificationCount() + getUnreadJoinRequestCount()
	);
	const showAttentionDot = $derived(!open && unreadNotificationTotal > 0);
</script>

<Collapsible.Root bind:open>
	<Collapsible.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase transition-colors hover:text-foreground"
				aria-label={open
					? 'Hide quick actions'
					: `Show quick actions${showAttentionDot ? ` (${unreadNotificationTotal} unread)` : ''}`}
			>
				Quick actions
				{#if showAttentionDot}
					<span class="size-2 rounded-full bg-destructive" aria-hidden="true"></span>
				{/if}
				<ChevronDown class="size-4 transition-transform [[data-state=open]_&]:rotate-180" />
			</button>
		{/snippet}
	</Collapsible.Trigger>
	<Collapsible.Content>
		<div class="pt-2">
			<ChatActionIcons {layout} {onNavigate} />
		</div>
	</Collapsible.Content>
</Collapsible.Root>
