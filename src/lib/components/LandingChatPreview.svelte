<script lang="ts">
	import { fly } from 'svelte/transition';
	import { resolve } from '$app/paths';
	import Avatar from '$lib/components/Avatar.svelte';
	import GroupAvatarFallback from '$lib/components/chat/GroupAvatarFallback.svelte';
	import { MESSAGE_TEXT_WRAP_CLASS } from '$lib/chat/messageTextClasses';
	import Check from '@lucide/svelte/icons/check';
	import Lock from '@lucide/svelte/icons/lock';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import { cn } from '$lib/utils';

	// Fake but stable pubkeys. pubkeyToHexColor() slices the first 6 chars, so
	// these give deterministic avatar colors without fetching real Nostr
	// profiles. They are NOT real identities — this is a static hero mock.
	const SAM = 'c24a7e0000000000000000000000000000000000000000000000000000000000';
	const YOU = '2f6bd100000000000000000000000000000000000000000000000000000000000';

	interface Line {
		own: boolean;
		name: string;
		text: string;
		time: string;
	}

	const messages: Line[] = [
		{ own: false, name: 'Sam', text: 'Fully private comms, finally. 🔒', time: '09:41' },
		{ own: true, name: 'You', text: 'Love it. No lock-in!', time: '09:41' },
		{ own: false, name: 'Sam', text: 'None. MLS encryption and Nostr keys.', time: '09:42' },
		{ own: true, name: 'You', text: 'Can I self-host it?', time: '09:42' },
		{ own: false, name: 'Sam', text: 'Of course. 🚀', time: '09:43' }
	];
</script>

<div
	class="w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-background shadow-xl ring-1 ring-foreground/5"
>
	<!-- Header: mirrors ChatHeader chrome (logo + title + encrypted pill) -->
	<div class="flex items-center gap-3 border-b border-border px-4 py-3">
		<div
			class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card p-1.5"
		>
			<GroupAvatarFallback logoClass="h-full w-full" />
		</div>
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-semibold tracking-tight">Cordn</p>
			<p class="flex items-center gap-1 text-xs text-muted-foreground">
				<Lock class="size-3" />
				End-to-end encrypted
			</p>
		</div>
	</div>

	<!-- Message list: bubble + row classes copied verbatim from ChatMessageItem -->
	<div class="flex flex-col gap-4 px-4 py-5">
		{#each messages as line, i (i)}
			<article
				class="flex min-w-0 items-end gap-2 sm:gap-3"
				class:flex-row-reverse={line.own}
				in:fly={{ y: 10, duration: 420, delay: 220 * i }}
			>
				<div class="flex h-8 w-8 shrink-0 items-end" class:justify-end={line.own}>
					<Avatar pubkey={line.own ? YOU : SAM} size="h-8 w-8" alt={line.name} />
				</div>

				<div
					class="flex max-w-[min(100%,30rem)] min-w-0 flex-1 items-end gap-1.5 sm:gap-2"
					class:flex-row-reverse={line.own}
				>
					<div class="relative flex max-w-full min-w-0 flex-col gap-1.5" class:items-end={line.own}>
						{#if !line.own}
							<p
								class="max-w-[12rem] truncate px-1 text-xs font-medium text-foreground/90 sm:max-w-[16rem]"
							>
								{line.name}
							</p>
						{/if}
						<div
							class={cn(
								'max-w-full min-w-0 overflow-hidden rounded-3xl border px-3 py-2.5 text-sm leading-6 shadow-sm transition-all sm:px-4 sm:py-3 sm:leading-7',
								line.own
									? 'border-primary bg-primary text-primary-foreground'
									: 'border-border bg-card',
								MESSAGE_TEXT_WRAP_CLASS
							)}
						>
							{line.text}
						</div>
					</div>

					<div
						class="flex shrink-0 items-center gap-1 self-end px-1 text-[10px] text-muted-foreground/80 sm:text-[11px]"
					>
						<span>{line.time}</span>
						{#if line.own}
							<span class="inline-flex items-center text-primary" aria-label="Sent" title="Sent">
								<Check class="size-3" />
							</span>
						{/if}
					</div>
				</div>
			</article>
		{/each}
	</div>

	<!-- Composer: decorative mock that opens the real chat -->
	<a
		href={resolve('/chat')}
		data-sveltekit-preload-data="off"
		class="block border-t border-border px-3 py-3 transition-colors hover:bg-muted/60"
	>
		<div
			class="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
		>
			<span class="flex-1 truncate">Message Cordn…</span>
			<span
				class="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground"
				aria-hidden="true"
			>
				<SendHorizontal class="size-3.5" />
			</span>
		</div>
	</a>
</div>
