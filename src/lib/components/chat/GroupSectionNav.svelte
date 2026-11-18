<script lang="ts">
	import { resolve } from '$app/paths';
	import { getLocalTimeZone, today } from '@internationalized/date';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import { groupRouteId } from '$lib/services/chatGroupLinks.svelte';
	import { groupCalendarCards } from '$lib/services/chatCalendar.svelte';
	import { cn } from '$lib/utils';

	/**
	 * Chat ↔ Calendar switch for one group. Two links, not tabs: each view is a
	 * real route (`/chat/[id]` and `/chat/[id]/cal`), so the switch is
	 * deep-linkable and Android Back stays hierarchy-driven.
	 */
	let { groupId, active }: { groupId: string; active: 'chat' | 'calendar' } = $props();

	const id = $derived(groupRouteId(groupId));
	const todayKey = today(getLocalTimeZone()).toString();
	// Same projection the calendar view reads: a dot only when an active event
	// covers today, never an unread badge.
	const hasEventsToday = $derived(
		groupCalendarCards(groupId).some((card) => !card.cancelled && card.dayKeys.includes(todayKey))
	);
	const links = $derived([
		{
			key: 'chat' as const,
			label: 'Chat',
			href: resolve('/chat/[id]', { id }),
			icon: MessageCircle
		},
		{
			key: 'calendar' as const,
			label: 'Calendar',
			href: resolve('/chat/[id]/cal', { id }),
			icon: CalendarDays
		}
	]);
</script>

<nav
	aria-label="Group views"
	class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5 md:px-6"
>
	{#each links as link (link.key)}
		<a
			href={link.href}
			aria-current={active === link.key ? 'page' : undefined}
			class={cn(
				'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
				active === link.key
					? 'bg-muted text-foreground'
					: 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
			)}
		>
			<link.icon class="size-3.5" aria-hidden="true" />
			{link.label}
			{#if link.key === 'calendar' && hasEventsToday}
				<span
					class="size-1.5 shrink-0 rounded-full bg-primary"
					title="There are events today"
					aria-hidden="true"
				></span>
				<span class="sr-only">events today</span>
			{/if}
		</a>
	{/each}
</nav>
