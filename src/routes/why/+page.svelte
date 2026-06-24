<script lang="ts">
	import { resolve } from '$app/paths';
	import MarkdownContent from '$lib/components/MarkdownContent.svelte';
	import markdownSource from '../../../docs/why-cordn.md?raw';
</script>

<svelte:head>
	<title>Why Cordn</title>
	<meta
		name="description"
		content="Why Cordn exists, what tradeoffs it makes, and how it approaches private group messaging."
	/>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<div class="mx-auto max-w-4xl px-6 py-16">
		<div class="mb-8">
			<a
				href={resolve('/')}
				class="inline-flex items-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
			>
				Back to home
			</a>
		</div>

		<div class="mb-10 space-y-4">
			<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">Why Cordn</p>
			<h1 class="text-4xl font-semibold tracking-tight md:text-5xl">Why Cordn exists.</h1>
			<p class="max-w-3xl text-lg leading-8 text-muted-foreground">
				An accessible explanation of the problem Cordn is solving, the tradeoffs it makes, and why
				private group messaging still needs clear coordination.
			</p>
		</div>

		<MarkdownContent source={markdownSource} class="mt-8" />
	</div>
</div>
