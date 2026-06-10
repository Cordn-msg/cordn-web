<script lang="ts">
	import { resolve } from '$app/paths';
	import Github from '@lucide/svelte/icons/git-branch';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Server from '@lucide/svelte/icons/server';
	import Shield from '@lucide/svelte/icons/shield';
	import { copyToClipboard } from '$lib/utils';

	const principles = [
		'No emails, or phone numbers. Just Nostr keys',
		'MLS-secured group messaging with clear per-group ordering',
		'Hosted or self-hosted coordinators, with a path to portability'
	];

	const highlights = [
		{
			icon: MessageSquare,
			title: 'Open protocol, not a silo',
			body: 'Cordn is a protocol for private group messaging with open-source clients and published drafts in the repo, so the model is inspectable and portable from the start.'
		},
		{
			icon: KeyRound,
			title: 'Identity without account lock-in',
			body: 'Use a stable Nostr public key when identity matters, without email, phone numbers, or platform accounts. For ordinary chat activity, ephemeral keys can reduce unnecessary exposure.'
		},
		{
			icon: Server,
			title: 'Private chat you can actually run',
			body: 'Cordn keeps the coordinator model MLS needs, but makes it practical to use a hosted coordinator, run your own, and keep a real path to move later.'
		}
	];

	const modelCards = [
		{
			step: '01',
			title: 'Coordinator',
			body: 'Cordn uses one coordinator per group to keep MLS state and message order clear. It is exposed through ContextVM instead of needing a conventional public server.',
			linkLabel: 'contextvm.org',
			linkHref: 'https://contextvm.org/'
		},
		{
			step: '02',
			title: 'Nostr relays',
			body: 'Nostr relays carry transport for reaching coordinators. That makes deployment simpler, even behind NATs, firewalls, and more constrained networks.'
		},
		{
			step: '03',
			title: 'Clients',
			body: 'Clients connect through relays to reach coordinators over ContextVM. Messages are encrypted before they leave the device, then delivered to the group with clear ordering.'
		}
	];

	const deploymentCommand = 'docker run --rm ghcr.io/cordn-msg/cordn:latest';
</script>

<svelte:head>
	<title>Cordn</title>
	<meta
		name="description"
		content="Cordn is private group messaging you can own, with Nostr-based identity, end-to-end encryption, and flexible deployment."
	/>
</svelte:head>

<div class="min-h-screen bg-background text-foreground">
	<header class="border-b border-border">
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
			<a href={resolve('/')} class="flex items-center gap-3 text-lg font-semibold tracking-tight">
				<img src="/cordn-logo-black.svg" alt="Cordn" class="h-8 w-auto dark:hidden" />
				<img src="/cordn-logo.svg" alt="Cordn" class="hidden h-8 w-auto dark:block" />
				<span>Cordn</span>
			</a>

			<nav class="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
				<a href="#why" class="transition-colors hover:text-foreground">Why Cordn</a>
				<a href="#how" class="transition-colors hover:text-foreground">How it works</a>
			</nav>

			<a
				href={resolve('/chat')}
				data-sveltekit-preload-data="off"
				class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
			>
				Open chat
			</a>
		</div>
	</header>
	<main>
		<section
			class="mx-auto grid min-h-[calc(100vh-73px)] max-w-6xl gap-12 px-6 py-20 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-center"
		>
			<div class="space-y-8">
				<div class="space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						Private chat without platform lock-in.
					</p>
					<h1 class="max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-6xl">
						Private messaging that you own.
					</h1>
					<p class="max-w-2xl text-lg leading-8 text-muted-foreground">
						Cordn is a protocol for private group messaging, and this web app is a fully functional
						client. It combines MLS end-to-end encryption, Nostr-based identity, and
						coordinator-based delivery you can use as a hosted service or run yourself.
					</p>
				</div>

				<div class="flex flex-col gap-3 sm:flex-row">
					<a
						href={resolve('/chat')}
						data-sveltekit-preload-data="off"
						class="inline-flex items-center justify-center rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
					>
						Open chat
					</a>
					<a
						href="https://github.com/Cordn-msg/cordn"
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-5 py-3 text-sm font-medium transition-colors hover:bg-muted"
					>
						<Github class="h-4 w-4" />
						<span>View repo</span>
					</a>
					<a
						href="#why"
						class="inline-flex items-center justify-center rounded-md border border-border bg-background px-5 py-3 text-sm font-medium transition-colors hover:bg-muted"
					>
						Learn how Cordn works
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

			<div class="flex justify-center lg:justify-end">
				<div
					class="flex w-full max-w-sm items-center justify-center rounded-3xl border border-border bg-card/70 p-8 shadow-sm backdrop-blur-sm"
				>
					<img
						src="/cordn-logo-black.svg"
						alt="Cordn logo"
						class="w-full max-w-[240px] dark:hidden"
					/>
					<img
						src="/cordn-logo.svg"
						alt="Cordn logo"
						class="hidden w-full max-w-[240px] dark:block"
					/>
				</div>
			</div>
		</section>

		<section class="border-y border-border bg-muted/30">
			<div class="mx-auto max-w-6xl px-6 py-12">
				<div
					class="grid gap-6 rounded-3xl border border-border bg-background p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
				>
					<div class="space-y-3">
						<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
							Run your own coordinator
						</p>
						<h2 class="text-2xl font-semibold tracking-tight md:text-3xl">
							Start with one command.
						</h2>
						<p class="max-w-2xl text-sm leading-7 text-muted-foreground">
							Self-hosting is meant to be practical. Start fast with Docker, then see the repo for
							more deployment options, docs, and protocol drafts.
						</p>
					</div>
					<a
						href="https://github.com/Cordn-msg/cordn"
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
					>
						Deployment docs
					</a>
					<div class="rounded-2xl border border-border bg-card p-4 md:col-span-2">
						<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<pre class="overflow-x-auto text-sm text-foreground"><code>{deploymentCommand}</code
								></pre>
							<button
								type="button"
								onclick={() => copyToClipboard(deploymentCommand)}
								class="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
							>
								Copy command
							</button>
						</div>
					</div>
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
						Private chat without platform lock-in.
					</h2>
					<p class="text-base leading-7 text-muted-foreground">
						Cordn gives people a real privacy choice. You can use a public coordinator and still
						keep message contents encrypted with a strong privacy baseline, or self-host your own
						coordinator when you want the most sovereign setup.
					</p>
					<a
						href={resolve('/why')}
						class="inline-flex items-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
					>
						Read more
					</a>
				</div>

				<div class="mt-10 grid gap-6 md:grid-cols-3">
					{#each highlights as highlight (highlight.title)}
						<article class="rounded-2xl border border-border bg-background p-6">
							<div
								class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted text-foreground"
							>
								<highlight.icon class="h-5 w-5" />
							</div>
							<h3 class="text-lg font-medium tracking-tight">{highlight.title}</h3>
							<p class="mt-3 text-sm leading-7 text-muted-foreground">{highlight.body}</p>
						</article>
					{/each}
				</div>
			</div>
		</section>

		<section id="how" class="mx-auto max-w-6xl px-6 py-16">
			<div class="max-w-3xl space-y-4">
				<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
					How it works
				</p>
				<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
					A simple model for private group chat.
				</h2>
				<p class="text-base leading-7 text-muted-foreground">
					Cordn keeps the model simple: one coordinator per group for ordered state, relays for
					transport, and clients that connect through ContextVM while keeping encryption on the
					device.
				</p>
			</div>

			<div class="mt-10 grid gap-4 md:grid-cols-3">
				{#each modelCards as card (card.step)}
					<div class="rounded-2xl border border-border p-6">
						<p class="text-sm text-muted-foreground">{card.step}</p>
						<h3 class="mt-2 text-lg font-medium">{card.title}</h3>
						<p class="mt-3 text-sm leading-7 text-muted-foreground">
							{card.body}
							{#if card.linkHref}
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={card.linkHref}
									target="_blank"
									rel="noreferrer"
									class="underline underline-offset-4"
								>
									{card.linkLabel}
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{/if}
						</p>
					</div>
				{/each}
			</div>
		</section>

		<section id="overview" class="border-t border-border">
			<div class="mx-auto grid max-w-6xl gap-8 px-6 py-16 md:grid-cols-[1fr_0.9fr]">
				<div class="space-y-4">
					<p class="text-sm font-medium tracking-[0.2em] text-muted-foreground uppercase">
						What this means for you
					</p>
					<h2 class="text-3xl font-semibold tracking-tight md:text-4xl">
						What makes Cordn different.
					</h2>
					<p class="text-base leading-7 text-muted-foreground">
						Cordn is still in beta, but the goal is simple: private messaging should be encrypted,
						portable, open source, and grounded in a protocol people can inspect.
					</p>
				</div>

				<div class="rounded-2xl border border-border bg-card p-6">
					<div class="space-y-5 text-sm leading-7 text-muted-foreground">
						<div>
							<div
								class="mb-2 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-card-foreground"
							>
								<Shield class="h-4 w-4" />
							</div>
							<p class="font-medium text-card-foreground">Less exposed traffic</p>
							<p>
								Cordn traffic blends into wider ContextVM traffic instead of standing out as its own
								public messaging stream.
							</p>
						</div>
						<div>
							<div
								class="mb-2 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-card-foreground"
							>
								<MessageSquare class="h-4 w-4" />
							</div>
							<p class="font-medium text-card-foreground">Encrypted before transport</p>
							<p>Messages are encrypted on your device before they are sent through the network.</p>
						</div>
						<div>
							<div
								class="mb-2 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-card-foreground"
							>
								<Github class="h-4 w-4" />
							</div>
							<p class="font-medium text-card-foreground">Protocol-first and portable</p>
							<p>
								Cordn is open source, specified in public drafts, and designed so groups are not
								locked to one provider model.
							</p>
						</div>
						<div>
							<div
								class="mb-2 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-card-foreground"
							>
								<KeyRound class="h-4 w-4" />
							</div>
							<p class="font-medium text-card-foreground">No account system required</p>
							<p>
								Use an existing Nostr identity, or create a fresh ephemeral key for routine chat
								use.
							</p>
						</div>
						<div class="border-t border-border pt-5">
							<p class="font-medium text-card-foreground">Open source and in beta</p>
							<p>
								See the projects on
								<a
									href="https://github.com/Cordn-msg/cordn"
									target="_blank"
									rel="noreferrer"
									class="underline underline-offset-4"
								>
									GitHub
								</a>
								for the coordinator and
								<a
									href="https://github.com/Cordn-msg/cordn-web"
									target="_blank"
									rel="noreferrer"
									class="underline underline-offset-4"
								>
									GitHub
								</a>
								for the web app.
							</p>
						</div>
					</div>
				</div>
			</div>
		</section>
	</main>
</div>
