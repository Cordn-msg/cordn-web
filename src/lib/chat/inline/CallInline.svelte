<script lang="ts">
	import type { InlineBodyProps } from '$lib/chat/registry';
	import { parseCallAnnouncement } from '$lib/chat/calls';
	import {
		chatCallsStore,
		groupCallCard,
		loadGroupCalls,
		openChatCall
	} from '$lib/services/chatCalls.svelte';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import Phone from '@lucide/svelte/icons/phone';
	import PhoneCall from '@lucide/svelte/icons/phone-call';
	import { cn } from '$lib/utils';

	let { message, groupId = '' }: InlineBodyProps = $props();
	let now = $state(Date.now());
	const card = $derived(groupId ? groupCallCard(groupId, message.eventId) : null);
	const announcement = $derived(
		card?.announcement ?? parseCallAnnouncement(message.kind, message.tags ?? [])
	);
	const isOwn = $derived(message.isOwn ?? false);
	const isActive = $derived(
		Boolean(
			announcement &&
			chatCallsStore.active?.groupId === groupId &&
			chatCallsStore.active.callId === announcement.callId
		)
	);
	const serviceHost = $derived.by(() => {
		if (!announcement) return '';
		try {
			return new URL(announcement.service).host;
		} catch {
			return announcement.service;
		}
	});
	const duration = $derived.by(() => {
		if (!announcement) return '';
		const end = announcement.endsAt ?? Math.floor(now / 1000);
		const seconds = Math.max(0, end - announcement.startsAt);
		if (seconds < 60) return announcement.status === 'open' ? 'just started' : 'under a minute';
		const minutes = Math.floor(seconds / 60);
		return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
	});

	$effect(() => {
		if (groupId) void loadGroupCalls(groupId);
	});
	$effect(() => {
		if (announcement?.status !== 'open') return;
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
</script>

{#if !announcement}
	<div class="mt-1 rounded-2xl border border-dashed px-3 py-2 text-sm text-muted-foreground italic">
		Unsupported call announcement
	</div>
{:else}
	<div
		class={cn(
			'mt-1 w-full max-w-md rounded-2xl border p-3',
			isOwn
				? 'border-primary-foreground/25 bg-primary-foreground/12'
				: 'border-border/70 bg-card/60'
		)}
	>
		<div class="flex items-center gap-3">
			<div
				class={cn(
					'flex size-11 shrink-0 items-center justify-center rounded-xl',
					announcement.status === 'open'
						? 'bg-emerald-500/15 text-emerald-600'
						: 'bg-muted text-muted-foreground'
				)}
			>
				<Phone class="size-5" />
			</div>
			<div class="min-w-0 flex-1">
				<p class={cn('text-sm font-semibold', isOwn && 'text-primary-foreground')}>
					{announcement.title ||
						(announcement.status === 'open' ? 'Call in progress' : 'Call ended')}
				</p>
				<div
					class={cn(
						'truncate text-xs',
						isOwn ? 'text-primary-foreground/80' : 'text-muted-foreground'
					)}
				>
					<ProfileCard
						pubkey={card?.message.sender ?? message.author}
						mode="inline"
						profileLink={false}
					/>
					<span> · {duration}</span>
				</div>
				{#if announcement.status === 'open'}
					<p
						class={cn(
							'mt-0.5 truncate text-[11px]',
							isOwn ? 'text-primary-foreground/70' : 'text-muted-foreground'
						)}
					>
						Token service: {serviceHost}
					</p>
				{/if}
			</div>
		</div>
		{#if announcement.status === 'open'}
			<Button
				variant={isOwn ? 'secondary' : 'default'}
				class="mt-3 w-full"
				onclick={() => void openChatCall(groupId, message.eventId)}
			>
				<PhoneCall />
				{isActive ? 'Return to call' : 'Join call'}
			</Button>
		{/if}
	</div>
{/if}
