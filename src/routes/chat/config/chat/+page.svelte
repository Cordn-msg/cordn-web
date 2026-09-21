<script lang="ts">
	import { resolve } from '$app/paths';
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import {
		getEnterKeyMode,
		setEnterKeyMode,
		enterKeySends,
		type EnterKeyMode
	} from '$lib/services/chatComposerSettings.svelte';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import Check from '@lucide/svelte/icons/check';

	const options: { mode: EnterKeyMode; label: string; desc: string }[] = [
		{
			mode: 'auto',
			label: 'Automatic (recommended)',
			desc: 'Enter sends on devices with a keyboard and inserts a new line on touch devices.'
		},
		{
			mode: 'send',
			label: 'Enter always sends',
			desc: 'Shift+Enter inserts a new line, everywhere.'
		},
		{
			mode: 'newline',
			label: 'Enter inserts a new line',
			desc: 'Send with Ctrl+Enter (⌘ on Mac) or the send button.'
		}
	];

	let mode = $state(getEnterKeyMode());

	function pick(next: EnterKeyMode) {
		mode = next;
		setEnterKeyMode(next);
	}

	// Shows what 'auto' currently resolves to on this device so the default
	// isn't a black box. Reads the reactive module state — updates live.
	const deviceSends = $derived(enterKeySends());
</script>

<svelte:head>
	<title>Chat behavior | Cordn</title>
	<meta name="description" content="Configure how the Enter key behaves while writing messages." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header
		class="flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6"
	>
		<ChatMobileSidebarButton />
		<div class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card">
			<Keyboard class="size-4" />
		</div>
		<div class="min-w-0">
			<h1 class="text-lg font-semibold tracking-tight">Chat behavior</h1>
			<p class="truncate text-sm text-muted-foreground">
				How the Enter key behaves while writing messages.
			</p>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="mx-auto grid max-w-3xl gap-6">
			<div class="space-y-3">
				{#each options as option (option.mode)}
					<button
						type="button"
						class="flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-colors {mode ===
						option.mode
							? 'border-primary bg-primary/5'
							: 'border-border hover:bg-muted/30'}"
						onclick={() => pick(option.mode)}
					>
						<div
							class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border {mode ===
							option.mode
								? 'border-primary bg-primary text-primary-foreground'
								: 'border-muted-foreground/40'}"
						>
							{#if mode === option.mode}
								<Check class="size-3" />
							{/if}
						</div>
						<div class="min-w-0">
							<p class="font-medium">{option.label}</p>
							<p class="mt-0.5 text-sm text-muted-foreground">{option.desc}</p>
							{#if option.mode === 'auto'}
								<p class="mt-0.5 text-xs text-muted-foreground">
									On this device, Enter currently
									{deviceSends ? 'sends the message' : 'inserts a new line'}.
								</p>
							{/if}
						</div>
					</button>
				{/each}
			</div>

			<div class="text-center">
				<a href={resolve('/chat/config')} class="text-sm text-muted-foreground hover:underline">
					Back to settings
				</a>
			</div>
		</div>
	</div>
</div>
