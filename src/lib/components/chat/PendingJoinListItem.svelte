<script lang="ts">
	import { resolve } from '$app/paths';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import GroupAvatarFallback from './GroupAvatarFallback.svelte';
	import type { SentJoinRequestEntry } from '$lib/services/chatJoinRequests.svelte';
	import { buildGroupSharePath } from '$lib/utils/groupShareLink';
	import X from '@lucide/svelte/icons/x';

	/**
	 * A group this account asked to join and is still waiting on an admin for: a
	 * chat-list row in its loading state, not a notification. It needs no action —
	 * the Welcome for the request is accepted on arrival (chatUiActions
	 * autoAcceptJoinRequestWelcomesAction), after which this row is gone because the
	 * group itself is here. The × only stops showing the wait; an admin may still
	 * let the reader in later.
	 *
	 * Nothing marks it unread, pinnable, or searchable: it holds no messages yet.
	 */
	let {
		entry,
		collapsed = false,
		variant = 'card',
		onclick,
		onremove
	}: {
		entry: SentJoinRequestEntry;
		collapsed?: boolean;
		variant?: 'card' | 'sidebar';
		onclick?: (event: MouseEvent) => void;
		onremove: () => void;
	} = $props();

	const isSidebar = $derived(variant === 'sidebar');
	const title = $derived(entry.name?.trim() || entry.gid);
	// A group we do not have yet, so groupRouteId has nothing to encode: the ref is
	// built from the request's own coordinator. A record written before records
	// carried one (the old gid array) falls back to the bare-gid route.
	const href = $derived(
		entry.coordinatorKey
			? buildGroupSharePath({
					groupId: entry.gid,
					coordinatorKey: entry.coordinatorKey,
					...(entry.name ? { metadata: { name: entry.name, icon: entry.icon } } : {})
				})
			: resolve('/chat/[id]', { id: entry.gid })
	);

	const linkClass = $derived.by(() => {
		if (isSidebar) {
			return `flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3 py-3 text-sm transition-colors ${collapsed ? 'justify-center px-2' : 'ml-1'} border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground`;
		}
		return 'group flex min-w-0 flex-1 items-center gap-3 rounded-2xl border border-border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/30';
	});
	const avatarClass = $derived(isSidebar ? 'h-10 w-10' : 'h-12 w-12');
</script>

<div class="flex items-center gap-1">
	<!-- The path is a resolved cordn1 ref (or $app/paths fallback), not a literal. -->
	<!-- eslint-disable svelte/no-navigation-without-resolve -->
	<a {href} {onclick} class={linkClass} title={`Waiting for an admin: ${title}`}>
		<div class="relative shrink-0">
			<Avatar class={`${avatarClass} border border-border bg-background`}>
				<AvatarFallback class="bg-background text-sm font-medium">
					<GroupAvatarFallback icon={entry.icon} />
				</AvatarFallback>
			</Avatar>
			{#if collapsed}
				<span
					class="absolute -right-0.5 -bottom-0.5 rounded-full bg-background p-0.5"
					aria-hidden="true"
				>
					<Spinner class="size-3" aria-hidden="true" />
				</span>
			{/if}
		</div>

		{#if !collapsed}
			<div class="min-w-0 flex-1 overflow-hidden">
				<p class="truncate font-medium text-foreground">{title}</p>
				<p
					class={isSidebar
						? 'truncate text-xs leading-5 text-muted-foreground'
						: 'truncate text-sm text-muted-foreground'}
				>
					Waiting for an admin to let you in…
				</p>
			</div>
			{#if isSidebar}
				<Spinner class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
			{/if}
		{/if}
	</a>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->

	{#if !collapsed}
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
			onclick={onremove}
			aria-label="Remove pending join request"
			title="Remove pending join request"
		>
			<X class="size-4" />
		</Button>
	{/if}
</div>
