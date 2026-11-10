<script lang="ts">
	import AccountLoginDialog from '$lib/components/AccountLoginDialog.svelte';
	import { Button } from '$lib/components/ui/button';
	import { resolve } from '$app/paths';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
	import Server from '@lucide/svelte/icons/server';

	let {
		onSkip = () => {},
		onStart = () => {},
		replay = false
	}: { onSkip?: () => void; onStart?: () => void; replay?: boolean } = $props();

	const pages = [
		{
			icon: LockKeyhole,
			title: 'Only your group can read it.',
			body: "Messages are encrypted on this device before they leave. The servers that carry them can't read them."
		},
		{
			icon: KeyRound,
			title: 'Your identity is a key you hold.',
			body: "No email, no phone number. If you keep your key on this device, make a backup — it's the only copy."
		},
		{
			icon: Server,
			title: 'A coordinator carries your messages.',
			body: "It puts them in order and can't read them. You start on Cordn's; joining a group from a link asks the admins to let you in."
		}
	] as const;

	let index = $state(0);
	const page = $derived(pages[index]);
	const Icon = $derived(page.icon);
	const isLast = $derived(index === pages.length - 1);
</script>

<div
	class="relative mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-8 py-8 text-center"
>
	<button
		type="button"
		class="absolute top-0 right-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
		onclick={onSkip}
	>
		{replay ? 'Close' : 'Skip'}
	</button>

	<div class="flex items-center gap-1.5" aria-label="How Cordn works">
		{#each pages as item, i (item.title)}
			<button
				type="button"
				aria-current={i === index ? 'true' : undefined}
				aria-label={`Page ${i + 1}: ${item.title}`}
				class="h-1.5 rounded-full transition-all {i === index
					? 'w-6 bg-primary'
					: 'w-1.5 bg-border hover:bg-muted-foreground/50'}"
				onclick={() => (index = i)}
			></button>
		{/each}
	</div>

	<div class="flex flex-col items-center gap-4">
		<div class="flex size-14 items-center justify-center rounded-2xl border border-border bg-card">
			<Icon class="size-6" aria-hidden="true" />
		</div>
		<div class="space-y-2">
			<h1 class="text-2xl font-semibold tracking-tight">{page.title}</h1>
			<p class="text-sm text-muted-foreground">{page.body}</p>
		</div>
	</div>

	<div class="flex w-full flex-col gap-2">
		{#if isLast && replay}
			<Button class="h-11 w-full text-base" onclick={onSkip}>Done</Button>
		{:else if isLast}
			<AccountLoginDialog
				triggerLabel="Get started"
				triggerVariant="default"
				triggerClass="h-11 w-full text-base"
				onOpenChange={(open) => {
					if (open) onStart();
				}}
			/>
		{:else}
			<Button class="h-11 w-full text-base" onclick={() => (index += 1)}>Next</Button>
		{/if}
		<div class="flex items-center justify-center gap-4">
			{#if index > 0}
				<button
					type="button"
					class="text-sm text-muted-foreground transition-colors hover:text-foreground"
					onclick={() => (index -= 1)}
				>
					Back
				</button>
			{/if}
			<a
				href={resolve('/')}
				class="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
			>
				What is Cordn?
			</a>
		</div>
	</div>
</div>
