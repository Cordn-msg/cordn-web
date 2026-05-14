<script lang="ts">
	import { resolve } from '$app/paths';

	const principles = [
		'Strong group security through MLS',
		'Sovereign deployment through ContextVM',
		'Clear ordering with a coordinator model designed for real-world messaging'
	];

	const highlights = [
		{
			title: 'What Cordn is',
			body: 'Cordn is a coordinator-assisted messaging protocol profile designed to make private group communication easier to deploy without giving up strong MLS guarantees.'
		},
		{
			title: 'Why it matters',
			body: 'It keeps the ordering discipline MLS needs while making hosted, self-hosted, and portable coordinator setups much more practical.'
		},
		{
			title: 'Who it is for',
			body: 'Teams, communities, and builders who want encrypted group messaging with a more sovereign and flexible deployment model.'
		}
	];
</script>

<svelte:head>
	<title>Cordn</title>
	<meta
		name="description"
		content="Cordn is a sovereign MLS messaging experience with deployable coordination over ContextVM."
	/>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<header class="border-b border-border">
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
			<a href={resolve('/')} class="flex items-center gap-3 text-lg font-semibold tracking-tight">
				<span class="text-2xl leading-none">🪢</span>
				<span>Cordn</span>
			</a>

			<nav class="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
				<a href="#why" class="transition-colors hover:text-foreground">Why Cordn</a>
				<a href="#how" class="transition-colors hover:text-foreground">How it works</a>
				<a href="#faq" class="transition-colors hover:text-foreground">Overview</a>
			</nav>

			<a
				href={resolve('/chat')}
				class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
			>
				Open chat
			</a>
		</div>
	</header>

	<main>
		<section class="mx-auto grid max-w-6xl gap-12 px-6 py-20 md:grid-cols-[1.2fr_0.8fr] md:py-28">
			<div class="space-y-8">
				<div class="space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						Private group messaging, deployable by design
					</p>
					<h1 class="max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-6xl">
						Cordn brings MLS messaging to a sovereign, firewall-tolerant web experience.
					</h1>
					<p class="max-w-2xl text-lg leading-8 text-muted-foreground">
						A simple entry point for understanding Cordn and a direct path into the chat app. Cordn
						combines strong group security, clear coordination, and a deployment model that does not
						depend on conventional public server exposure.
					</p>
				</div>

				<div class="flex flex-col gap-3 sm:flex-row">
					<a
						href={resolve('/chat')}
						class="inline-flex items-center justify-center rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
					>
						Open chat
					</a>
					<a
						href="#why"
						class="inline-flex items-center justify-center rounded-md border border-border bg-background px-5 py-3 text-sm font-medium transition-colors hover:bg-muted"
					>
						Learn why Cordn exists
					</a>
				</div>

				<ul class="grid gap-3 text-sm text-muted-foreground">
					{#each principles as principle (principle)}
						<li
							class="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground"
						>
							<span class="mt-0.5 text-base leading-none text-foreground">•</span>
							<span>{principle}</span>
						</li>
					{/each}
				</ul>
			</div>

			<div class="rounded-2xl border border-border bg-card p-6 shadow-sm">
				<div class="space-y-5">
					<div class="flex items-center gap-3 border-b border-border pb-4">
						<div class="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-lg">
							🪢
						</div>
						<div>
							<p class="font-medium">Cordn web app</p>
							<p class="text-sm text-muted-foreground">Landing first, app one click away</p>
						</div>
					</div>

					<div class="space-y-3 text-sm text-muted-foreground">
						<p>
							This first version keeps the structure intentionally minimal: explain the protocol,
							show the core ideas, and let users enter the app immediately.
						</p>
						<p>
							As the product evolves, this area can become a UI preview, an interactive demo, or a
							live activity panel.
						</p>
					</div>

					<a
						href={resolve('/chat')}
						class="inline-flex w-full items-center justify-center rounded-md bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground transition-colors hover:bg-muted"
					>
						Go to chat placeholder
					</a>
				</div>
			</div>
		</section>

		<section id="why" class="border-y border-border bg-muted/30">
			<div class="mx-auto max-w-6xl px-6 py-16">
				<div class="max-w-3xl space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						Why Cordn
					</p>
					<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
						A coordinator model that respects how MLS actually works.
					</h2>
					<p class="text-base leading-7 text-muted-foreground">
						Cordn does not try to remove coordination from secure group messaging. It makes that
						coordination easier to deploy, easier to move, and more practical for self-hosted or
						hosted setups alike.
					</p>
				</div>

				<div class="mt-10 grid gap-6 md:grid-cols-3">
					{#each highlights as highlight (highlight.title)}
						<article class="rounded-2xl border border-border bg-background p-6">
							<h3 class="text-lg font-medium tracking-tight">{highlight.title}</h3>
							<p class="mt-3 text-sm leading-7 text-muted-foreground">{highlight.body}</p>
						</article>
					{/each}
				</div>
			</div>
		</section>

		<section id="how" class="mx-auto max-w-6xl px-6 py-16">
			<div class="max-w-2xl space-y-4">
				<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
					How it works
				</p>
				<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
					Security, coordination, and deployability in one stack.
				</h2>
				<p class="text-base leading-7 text-muted-foreground">
					Cordn uses MLS for secure group state, a coordinator for ordered delivery, and ContextVM
					for a more portable transport and hosting model.
				</p>
			</div>

			<div class="mt-10 grid gap-4 md:grid-cols-3">
				<div class="rounded-2xl border border-border p-6">
					<p class="text-sm text-muted-foreground">01</p>
					<h3 class="mt-2 text-lg font-medium">Identity and setup</h3>
					<p class="mt-3 text-sm leading-7 text-muted-foreground">
						Users bring key-based identity and connect to a coordinator model designed for group
						consistency.
					</p>
				</div>
				<div class="rounded-2xl border border-border p-6">
					<p class="text-sm text-muted-foreground">02</p>
					<h3 class="mt-2 text-lg font-medium">Ordered group messaging</h3>
					<p class="mt-3 text-sm leading-7 text-muted-foreground">
						Per-group ordering and fetch semantics make the chat experience dependable instead of
						guessing over weak dissemination.
					</p>
				</div>
				<div class="rounded-2xl border border-border p-6">
					<p class="text-sm text-muted-foreground">03</p>
					<h3 class="mt-2 text-lg font-medium">Portable deployment</h3>
					<p class="mt-3 text-sm leading-7 text-muted-foreground">
						Hosted, self-hosted, or temporary coordinators can all fit the same product story.
					</p>
				</div>
			</div>
		</section>

		<section id="faq" class="border-t border-border">
			<div class="mx-auto grid max-w-6xl gap-8 px-6 py-16 md:grid-cols-[1fr_0.9fr]">
				<div class="space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						Overview
					</p>
					<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
						Start simple now, expand later.
					</h2>
					<p class="text-base leading-7 text-muted-foreground">
						This first landing page is a lightweight foundation. It already gives Cordn a clear
						identity, explains the product direction, and separates the homepage from the future
						chat workspace.
					</p>
				</div>

				<div class="rounded-2xl border border-border bg-card p-6">
					<div class="space-y-5 text-sm leading-7 text-muted-foreground">
						<div>
							<p class="font-medium text-card-foreground">What is live today?</p>
							<p>A minimal homepage and a dedicated route for the future chat application.</p>
						</div>
						<div>
							<p class="font-medium text-card-foreground">What comes next?</p>
							<p>
								Refined copy, real app screens, docs links, and a more complete product navigation.
							</p>
						</div>
						<div>
							<p class="font-medium text-card-foreground">Primary action</p>
							<p>Use the dedicated chat route when the app experience is ready to grow.</p>
						</div>
					</div>
				</div>
			</div>
		</section>
	</main>
</div>
