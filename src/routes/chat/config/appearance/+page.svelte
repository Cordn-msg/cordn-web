<script lang="ts">
	import ChatMobileSidebarButton from '$lib/components/chat/ChatMobileSidebarButton.svelte';
	import * as Card from '$lib/components/ui/card';
	import ThemeGallery from '$lib/components/appearance/ThemeGallery.svelte';
	import ThemeEditor from '$lib/components/appearance/ThemeEditor.svelte';
	import { activeTheme, forkTheme } from '$lib/themes/appearance.svelte';
	import type { ThemeDefinition } from '$lib/themes/types';
	import Palette from '@lucide/svelte/icons/palette';
	import Plus from '@lucide/svelte/icons/plus';
	import { resetMode, setMode, userPrefersMode } from 'mode-watcher';
	import { Button } from '$lib/components/ui/button';

	let editing = $state<ThemeDefinition | null>(null);

	function chooseMode(mode: 'light' | 'dark' | 'system') {
		if (mode === 'system') resetMode();
		else setMode(mode);
	}

	function startNewTheme() {
		// Start from the active theme's values - a fully blank set would be invalid hex.
		editing = { ...forkTheme(activeTheme()), name: 'New theme' };
	}

	const modes = [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' },
		{ value: 'system', label: 'System' }
	] as const;
</script>

<svelte:head>
	<title>Appearance | Cordn</title>
	<meta name="description" content="Choose and customize Cordn themes." />
</svelte:head>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<header class="border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
		<div class="flex items-center gap-3">
			<ChatMobileSidebarButton />
			<div
				class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card"
			>
				<Palette class="size-4" />
			</div>
			<div class="min-w-0">
				<h1 class="text-lg font-semibold tracking-tight">Appearance</h1>
			</div>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
		<div class="lg:grid-cols mx-auto grid max-w-4xl gap-6">
			<div class="min-w-0 space-y-6">
				<Card.Root>
					<Card.Header>
						<Card.Title>Color mode</Card.Title>
						<Card.Description>
							Every theme has a light and a dark variant — pick when Cordn uses each.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						<div
							class="inline-flex rounded-lg border border-border p-1"
							role="radiogroup"
							aria-label="Color mode"
						>
							{#each modes as m (m.value)}
								<button
									type="button"
									role="radio"
									aria-checked={userPrefersMode.current === m.value}
									class="rounded-md px-3 py-1 text-sm font-medium transition-colors
										{userPrefersMode.current === m.value
										? 'bg-primary text-primary-foreground'
										: 'text-muted-foreground hover:text-foreground'}"
									onclick={() => chooseMode(m.value)}
								>
									{m.label}
								</button>
							{/each}
						</div>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Themes</Card.Title>
						<Card.Description>
							Switch instantly — the whole app previews each theme. Customize any theme to create
							your own.
						</Card.Description>
					</Card.Header>
					<Card.Content>
						{#if editing}
							<ThemeEditor
								source={editing}
								oncancel={() => (editing = null)}
								onsaved={() => (editing = null)}
							/>
						{:else}
							<ThemeGallery onedit={(theme: ThemeDefinition) => (editing = theme)} />
							<div class="mt-3 flex flex-wrap gap-2">
								<Button type="button" variant="outline" onclick={() => (editing = activeTheme())}>
									<Palette class="size-4" /> Customize current theme
								</Button>
								<Button type="button" variant="outline" onclick={startNewTheme}>
									<Plus class="size-4" /> New theme
								</Button>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			</div>
		</div>
	</div>
</div>
